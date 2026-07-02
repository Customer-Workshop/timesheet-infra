import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../lib/bootstrap-stack';

describe('BootstrapStack', () => {
  let app: cdk.App;
  let stack: BootstrapStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new BootstrapStack(app, 'TestBootstrapStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      githubOrg: 'Cognition-Partner-Workshops',
      githubRepo: 'hosting-client-timesheet-app',
      allowDestroy: true,
    });
    template = Template.fromStack(stack);
  });

  describe('S3 Terraform State Bucket', () => {
    it('creates a versioned S3 bucket for terraform state', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.objectLike({
          'Fn::Join': Match.anyValue(),
        }),
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      });
    });

    it('blocks all public access on the state bucket', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });
  });

  describe('DynamoDB Lock Table', () => {
    it('creates a DynamoDB table for terraform locks', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'client-timesheet-terraform-locks',
        KeySchema: [
          { AttributeName: 'LockID', KeyType: 'HASH' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      });
    });
  });

  describe('ECR Repository', () => {
    it('creates an ECR repository with scan on push', () => {
      template.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: 'client-timesheet-app',
        ImageScanningConfiguration: {
          ScanOnPush: true,
        },
        ImageTagMutability: 'MUTABLE',
      });
    });

    it('has a lifecycle policy keeping last 10 images', () => {
      template.hasResourceProperties('AWS::ECR::Repository', {
        LifecyclePolicy: {
          LifecyclePolicyText: Match.stringLikeRegexp('imageCountMoreThan.*10'),
        },
      });
    });
  });

  describe('GitHub Actions OIDC', () => {
    it('creates an OIDC provider for GitHub Actions', () => {
      template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
        Url: 'https://token.actions.githubusercontent.com',
        ClientIDList: ['sts.amazonaws.com'],
      });
    });

    it('creates an IAM role for GitHub Actions deployments', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'client-timesheet-github-actions-deploy',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Condition: Match.objectLike({
                StringEquals: Match.objectLike({
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                }),
                StringLike: Match.objectLike({
                  'token.actions.githubusercontent.com:sub': 'repo:Cognition-Partner-Workshops/hosting-client-timesheet-app:*',
                }),
              }),
            }),
          ]),
        }),
      });
    });

    it('grants ECR push/pull permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ecr:GetAuthorizationToken',
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        }),
      });
    });

    it('grants SSM send command permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'ssm:SendCommand',
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('grants Lambda update permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['lambda:UpdateFunctionCode']),
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });
  });

  describe('Outputs', () => {
    it('exports the ECR repository URL', () => {
      template.hasOutput('EcrRepositoryUrl', {});
    });

    it('exports the GitHub Actions role ARN', () => {
      template.hasOutput('GitHubActionsRoleArn', {});
    });

    it('exports the terraform state bucket name', () => {
      template.hasOutput('TerraformStateBucketName', {});
    });
  });
});
