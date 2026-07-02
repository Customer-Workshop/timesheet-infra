import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ServerlessStack } from '../lib/serverless-stack';

describe('ServerlessStack', () => {
  let app: cdk.App;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    const stack = new ServerlessStack(app, 'TestServerlessStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      appName: 'client-timesheet-app',
      environment: 'production',
      lambdaMemorySize: 256,
      lambdaTimeout: 30,
      enableSonarqube: true,
      sonarqubeCpu: 512,
      sonarqubeMemory: 2048,
    });
    template = Template.fromStack(stack);
  });

  describe('DynamoDB Tables', () => {
    it('creates the users table with email as partition key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'client-timesheet-app-users',
        KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('creates the clients table with a GSI on user_email', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'client-timesheet-app-clients',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'user_email-index',
            KeySchema: [{ AttributeName: 'user_email', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });

    it('creates the work entries table with two GSIs', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'client-timesheet-app-work-entries',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'user_email-index',
            KeySchema: [{ AttributeName: 'user_email', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          }),
          Match.objectLike({
            IndexName: 'client_id-index',
            KeySchema: [{ AttributeName: 'client_id', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });
  });

  describe('S3 Frontend Bucket', () => {
    it('creates an S3 bucket with website configuration', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        WebsiteConfiguration: {
          IndexDocument: 'index.html',
          ErrorDocument: 'index.html',
        },
      });
    });

    it('allows public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        },
      });
    });
  });

  describe('Lambda Function', () => {
    it('creates a Lambda function with Node.js 20 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'client-timesheet-app-api',
        Runtime: 'nodejs20.x',
        Handler: 'lambda.handler',
        MemorySize: 256,
        Timeout: 30,
      });
    });

    it('sets the correct environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'client-timesheet-app-api',
        Environment: {
          Variables: Match.objectLike({
            NODE_ENV: 'production',
            DB_MODE: 'dynamodb',
          }),
        },
      });
    });

    it('creates a function URL with no auth', () => {
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'NONE',
        Cors: Match.objectLike({
          AllowOrigins: ['*'],
          AllowMethods: ['*'],
          AllowHeaders: ['*'],
          MaxAge: 86400,
        }),
      });
    });

    it('grants DynamoDB access to the Lambda role', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
              ]),
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });
  });

  describe('API Gateway', () => {
    it('creates an HTTP API', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        Name: 'client-timesheet-app-api',
        ProtocolType: 'HTTP',
        CorsConfiguration: Match.objectLike({
          AllowOrigins: ['*'],
          AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']),
          AllowHeaders: ['*'],
          MaxAge: 86400,
        }),
      });
    });

    it('creates a Lambda integration', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
        IntegrationType: 'AWS_PROXY',
        PayloadFormatVersion: '2.0',
      });
    });

    it('creates a default stage with auto-deploy', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: '$default',
        AutoDeploy: true,
      });
    });
  });

  describe('SonarQube on Fargate', () => {
    it('creates an ECS cluster', () => {
      template.hasResourceProperties('AWS::ECS::Cluster', {
        ClusterName: 'client-timesheet-app-sonarqube',
      });
    });

    it('creates a security group for SonarQube with port 9000', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'client-timesheet-app-sonarqube-sg',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            FromPort: 9000,
            ToPort: 9000,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      });
    });

    it('creates an EFS security group for NFS traffic', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'client-timesheet-app-sonarqube-efs-sg',
        GroupDescription: 'Security group for SonarQube EFS',
      });
    });

    it('creates an EFS filesystem', () => {
      template.hasResourceProperties('AWS::EFS::FileSystem', {
        Encrypted: false,
        LifecyclePolicies: Match.arrayWith([
          Match.objectLike({
            TransitionToIA: 'AFTER_7_DAYS',
          }),
        ]),
      });
    });

    it('creates a Fargate task definition with correct resources', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: 'client-timesheet-app-sonarqube',
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        Cpu: '512',
        Memory: '2048',
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'sonarqube',
            Image: 'sonarqube:lts-community',
            Essential: true,
            PortMappings: Match.arrayWith([
              Match.objectLike({
                ContainerPort: 9000,
                HostPort: 9000,
                Protocol: 'tcp',
              }),
            ]),
            Environment: Match.arrayWith([
              Match.objectLike({
                Name: 'SONAR_ES_BOOTSTRAP_CHECKS_DISABLE',
                Value: 'true',
              }),
            ]),
          }),
        ]),
      });
    });

    it('creates an ECS service with FARGATE_SPOT', () => {
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: 'sonarqube',
        DesiredCount: 1,
        LaunchType: Match.absent(),
        CapacityProviderStrategy: Match.arrayWith([
          Match.objectLike({
            CapacityProvider: 'FARGATE_SPOT',
            Weight: 1,
          }),
        ]),
        NetworkConfiguration: Match.objectLike({
          AwsvpcConfiguration: Match.objectLike({
            AssignPublicIp: 'ENABLED',
          }),
        }),
      });
    });
  });

  describe('Outputs', () => {
    it('outputs the API endpoint', () => {
      template.hasOutput('ApiEndpoint', {});
    });

    it('outputs the Lambda function URL', () => {
      template.hasOutput('LambdaFunctionUrl', {});
    });

    it('outputs the frontend URL', () => {
      template.hasOutput('FrontendUrl', {});
    });

    it('outputs the frontend bucket name', () => {
      template.hasOutput('FrontendBucketName', {});
    });

    it('outputs the DynamoDB table names', () => {
      template.hasOutput('DynamoDbUsersTable', {});
      template.hasOutput('DynamoDbClientsTable', {});
      template.hasOutput('DynamoDbWorkEntriesTable', {});
    });

    it('outputs the SonarQube cluster name', () => {
      template.hasOutput('SonarQubeClusterOutput', {});
    });
  });
});

describe('ServerlessStack with SonarQube disabled', () => {
  it('does not create ECS resources when enableSonarqube is false', () => {
    const app = new cdk.App();
    const stack = new ServerlessStack(app, 'TestNoSonarStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      appName: 'client-timesheet-app',
      environment: 'production',
      lambdaMemorySize: 256,
      lambdaTimeout: 30,
      enableSonarqube: false,
      sonarqubeCpu: 512,
      sonarqubeMemory: 2048,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::ECS::Cluster', 0);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 0);
    template.resourceCountIs('AWS::EFS::FileSystem', 0);
  });
});
