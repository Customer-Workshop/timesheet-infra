import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BootstrapStackProps extends cdk.StackProps {
  githubOrg: string;
  githubRepo: string;
  allowDestroy: boolean;
}

export class BootstrapStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;
  public readonly terraformStateBucket: s3.Bucket;
  public readonly terraformLockTable: dynamodb.Table;
  public readonly githubActionsRole: iam.Role;

  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);

    const tags: Record<string, string> = {
      Environment: 'shared',
      Project: 'client-timesheet-app',
      ManagedBy: 'aws-cdk',
    };

    // =========================================================================
    // Terraform State Backend Resources
    // =========================================================================

    this.terraformStateBucket = new s3.Bucket(this, 'TerraformStateBucket', {
      bucketName: `client-timesheet-terraform-state-${cdk.Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: props.allowDestroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.allowDestroy,
    });

    this.terraformLockTable = new dynamodb.Table(this, 'TerraformLockTable', {
      tableName: 'client-timesheet-terraform-locks',
      partitionKey: { name: 'LockID', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.allowDestroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================================
    // ECR Repository
    // =========================================================================

    this.ecrRepository = new ecr.Repository(this, 'AppEcrRepository', {
      repositoryName: 'client-timesheet-app',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy: props.allowDestroy ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: props.allowDestroy,
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
        },
      ],
    });

    // =========================================================================
    // GitHub Actions OIDC Provider and Deployment Role
    // =========================================================================

    const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubActionsOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    this.githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'client-timesheet-github-actions-deploy',
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.githubOrg}/${props.githubRepo}:*`,
          },
        },
      ),
    });

    // ECR Push/Pull Policy
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRGetAuthToken',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRPushPull',
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
      ],
      resources: [this.ecrRepository.repositoryArn],
    }));

    // EC2 Describe Policy
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EC2DescribeAll',
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // SSM Send Command Policy
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMSendCommand',
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:aws:ssm:${cdk.Aws.REGION}::document/AWS-RunShellScript`,
        `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/*`,
      ],
      conditions: {
        StringEquals: {
          'ssm:resourceTag/Project': 'client-timesheet-app',
        },
      },
    }));

    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMGetCommandInvocation',
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));

    // Lambda deployment permissions
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'LambdaUpdateCode',
      actions: [
        'lambda:UpdateFunctionCode',
        'lambda:GetFunction',
        'lambda:GetFunctionConfiguration',
      ],
      resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:client-timesheet-app-*`],
    }));

    // S3 frontend deployment permissions
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3FrontendDeploy',
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:DeleteObject',
        's3:ListBucket',
      ],
      resources: [
        `arn:aws:s3:::client-timesheet-app-frontend-${cdk.Aws.ACCOUNT_ID}`,
        `arn:aws:s3:::client-timesheet-app-frontend-${cdk.Aws.ACCOUNT_ID}/*`,
      ],
    }));

    // Terraform state access
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TerraformStateAccess',
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        this.terraformStateBucket.bucketArn,
        `${this.terraformStateBucket.bucketArn}/*`,
      ],
    }));

    // DynamoDB state lock
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBStateLock',
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [this.terraformLockTable.tableArn],
    }));

    // ECS/SonarQube permissions
    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECSClusterAccess',
      actions: [
        'ecs:DescribeServices',
        'ecs:DescribeTasks',
        'ecs:ListTasks',
        'ecs:UpdateService',
      ],
      resources: [
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/client-timesheet-app-sonarqube`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:service/client-timesheet-app-sonarqube/*`,
        `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/client-timesheet-app-sonarqube/*`,
      ],
    }));

    this.githubActionsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EC2DescribeNetworkInterfaces',
      actions: ['ec2:DescribeNetworkInterfaces'],
      resources: ['*'],
    }));

    // Apply tags
    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // =========================================================================
    // Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'TerraformStateBucketName', {
      description: 'S3 bucket for Terraform state',
      value: this.terraformStateBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'TerraformLockTableName', {
      description: 'DynamoDB table for Terraform state locking',
      value: this.terraformLockTable.tableName!,
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUrl', {
      description: 'ECR repository URL for the application',
      value: this.ecrRepository.repositoryUri,
    });

    new cdk.CfnOutput(this, 'EcrRepositoryName', {
      description: 'ECR repository name',
      value: this.ecrRepository.repositoryName,
    });

    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      description: 'IAM Role ARN for GitHub Actions to assume via OIDC',
      value: this.githubActionsRole.roleArn,
    });

    new cdk.CfnOutput(this, 'GitHubActionsOidcProviderArn', {
      description: 'GitHub Actions OIDC Provider ARN',
      value: githubOidcProvider.openIdConnectProviderArn,
    });
  }
}
