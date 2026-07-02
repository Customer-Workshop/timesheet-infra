import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ServerlessStackProps extends cdk.StackProps {
  appName: string;
  environment: string;
  lambdaMemorySize: number;
  lambdaTimeout: number;
  enableSonarqube: boolean;
  sonarqubeCpu: number;
  sonarqubeMemory: number;
}

export class ServerlessStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly clientsTable: dynamodb.Table;
  public readonly workEntriesTable: dynamodb.Table;
  public readonly frontendBucket: s3.Bucket;
  public readonly lambdaFunction: lambda.Function;
  public readonly httpApi: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props: ServerlessStackProps) {
    super(scope, id, props);

    const commonTags: Record<string, string> = {
      Environment: props.environment,
      Project: props.appName,
      ManagedBy: 'aws-cdk',
    };

    // =========================================================================
    // DynamoDB Tables (Scale-to-Zero with On-Demand Billing)
    // =========================================================================

    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${props.appName}-users`,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.clientsTable = new dynamodb.Table(this, 'ClientsTable', {
      tableName: `${props.appName}-clients`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.clientsTable.addGlobalSecondaryIndex({
      indexName: 'user_email-index',
      partitionKey: { name: 'user_email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.workEntriesTable = new dynamodb.Table(this, 'WorkEntriesTable', {
      tableName: `${props.appName}-work-entries`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.workEntriesTable.addGlobalSecondaryIndex({
      indexName: 'user_email-index',
      partitionKey: { name: 'user_email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.workEntriesTable.addGlobalSecondaryIndex({
      indexName: 'client_id-index',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =========================================================================
    // S3 Bucket for Frontend (Static Website Hosting)
    // =========================================================================

    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${props.appName}-frontend-${cdk.Aws.ACCOUNT_ID}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // =========================================================================
    // Lambda Function for Backend API
    // =========================================================================

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName: `${props.appName}-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.usersTable.tableArn,
        `${this.usersTable.tableArn}/index/*`,
        this.clientsTable.tableArn,
        `${this.clientsTable.tableArn}/index/*`,
        this.workEntriesTable.tableArn,
        `${this.workEntriesTable.tableArn}/index/*`,
      ],
    }));

    this.lambdaFunction = new lambda.Function(this, 'ApiFunction', {
      functionName: `${props.appName}-api`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'lambda.handler',
      memorySize: props.lambdaMemorySize,
      timeout: cdk.Duration.seconds(props.lambdaTimeout),
      role: lambdaRole,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambda')),
      environment: {
        NODE_ENV: props.environment,
        DB_MODE: 'dynamodb',
        USERS_TABLE: this.usersTable.tableName!,
        CLIENTS_TABLE: this.clientsTable.tableName!,
        WORK_ENTRIES_TABLE: this.workEntriesTable.tableName!,
        FRONTEND_URL: this.frontendBucket.bucketWebsiteUrl,
      },
    });

    // Lambda Function URL (direct access)
    const functionUrl = this.lambdaFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
        maxAge: cdk.Duration.seconds(86400),
      },
    });

    // =========================================================================
    // API Gateway (HTTP API)
    // =========================================================================

    this.httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${props.appName}-api`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['*'],
        maxAge: cdk.Duration.seconds(86400),
      },
    });

    const lambdaIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      this.lambdaFunction,
    );

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // =========================================================================
    // SonarQube on Fargate Spot (Conditional)
    // =========================================================================

    if (props.enableSonarqube) {
      this.createSonarQubeResources(props, commonTags);
    }

    // Apply common tags
    Object.entries(commonTags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // =========================================================================
    // Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      description: 'API Gateway endpoint URL',
      value: this.httpApi.apiEndpoint,
    });

    new cdk.CfnOutput(this, 'LambdaFunctionUrl', {
      description: 'Lambda function URL (direct access)',
      value: functionUrl.url,
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      description: 'S3 website URL for frontend',
      value: `http://${this.frontendBucket.bucketWebsiteDomainName}`,
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      description: 'S3 bucket name for frontend deployment',
      value: this.frontendBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'DynamoDbUsersTable', {
      description: 'DynamoDB Users table name',
      value: this.usersTable.tableName!,
    });

    new cdk.CfnOutput(this, 'DynamoDbClientsTable', {
      description: 'DynamoDB Clients table name',
      value: this.clientsTable.tableName!,
    });

    new cdk.CfnOutput(this, 'DynamoDbWorkEntriesTable', {
      description: 'DynamoDB Work Entries table name',
      value: this.workEntriesTable.tableName!,
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      description: 'Lambda function name for deployments',
      value: this.lambdaFunction.functionName,
    });
  }

  private createSonarQubeResources(props: ServerlessStackProps, tags: Record<string, string>): void {
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // Security Group for SonarQube
    const sonarqubeSg = new ec2.SecurityGroup(this, 'SonarQubeSecurityGroup', {
      vpc,
      securityGroupName: `${props.appName}-sonarqube-sg`,
      description: 'Security group for SonarQube',
      allowAllOutbound: true,
    });

    sonarqubeSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9000),
      'SonarQube Web UI',
    );

    // EFS for SonarQube data persistence
    const efsSg = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc,
      securityGroupName: `${props.appName}-sonarqube-efs-sg`,
      description: 'Security group for SonarQube EFS',
      allowAllOutbound: true,
    });

    efsSg.addIngressRule(
      sonarqubeSg,
      ec2.Port.tcp(2049),
      'NFS from SonarQube',
    );

    const fileSystem = new efs.FileSystem(this, 'SonarQubeEfs', {
      vpc,
      encrypted: false,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      securityGroup: efsSg,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'SonarQubeEcsCluster', {
      clusterName: `${props.appName}-sonarqube`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
      enableFargateCapacityProviders: true,
    });

    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'SonarQubeTaskDef', {
      family: `${props.appName}-sonarqube`,
      cpu: props.sonarqubeCpu,
      memoryLimitMiB: props.sonarqubeMemory,
    });

    const logGroup = new logs.LogGroup(this, 'SonarQubeLogGroup', {
      logGroupName: `/ecs/${props.appName}-sonarqube`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    taskDefinition.addContainer('SonarQubeContainer', {
      containerName: 'sonarqube',
      image: ecs.ContainerImage.fromRegistry('sonarqube:lts-community'),
      essential: true,
      portMappings: [
        {
          containerPort: 9000,
          hostPort: 9000,
          protocol: ecs.Protocol.TCP,
        },
      ],
      environment: {
        SONAR_ES_BOOTSTRAP_CHECKS_DISABLE: 'true',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'sonarqube',
      }),
    });

    // ECS Service with Fargate Spot
    new ecs.FargateService(this, 'SonarQubeService', {
      serviceName: 'sonarqube',
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [sonarqubeSg],
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
      ],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Outputs for SonarQube
    new cdk.CfnOutput(this, 'SonarQubeClusterOutput', {
      description: 'ECS cluster name for SonarQube',
      value: cluster.clusterName,
    });

    new cdk.CfnOutput(this, 'SonarQubeInfo', {
      description: 'SonarQube access information',
      value: 'SonarQube runs on Fargate Spot. Get the public IP from ECS task. Default login: admin/admin',
    });
  }
}
