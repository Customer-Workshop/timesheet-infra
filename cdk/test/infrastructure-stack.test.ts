import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { InfrastructureStack } from '../lib/infrastructure-stack';

describe('InfrastructureStack', () => {
  let app: cdk.App;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();

    // Create a mock ECR repository in a separate stack
    const ecrStack = new cdk.Stack(app, 'EcrStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const ecrRepo = new ecr.Repository(ecrStack, 'MockEcr', {
      repositoryName: 'client-timesheet-app',
    });

    const stack = new InfrastructureStack(app, 'TestInfrastructureStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      ecrRepository: ecrRepo,
      environment: 'production',
      instanceType: 't3.micro',
      appPort: 3001,
    });
    template = Template.fromStack(stack);
  });

  describe('Security Group', () => {
    it('creates a security group with HTTP ingress', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: 'Security group for Client Timesheet App',
        GroupName: 'client-timesheet-app-sg',
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            FromPort: 80,
            ToPort: 80,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
            Description: 'HTTP',
          }),
        ]),
      });
    });

    it('creates a security group with HTTPS ingress', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            FromPort: 443,
            ToPort: 443,
            IpProtocol: 'tcp',
            CidrIp: '0.0.0.0/0',
            Description: 'HTTPS',
          }),
        ]),
      });
    });

    it('allows all outbound traffic', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            IpProtocol: '-1',
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      });
    });
  });

  describe('IAM Role', () => {
    it('creates an EC2 role with SSM managed policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'client-timesheet-ec2-role',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'ec2.amazonaws.com' },
            }),
          ]),
        }),
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp('AmazonSSMManagedInstanceCore'),
              ]),
            ]),
          }),
        ]),
      });
    });

    it('creates an instance profile', () => {
      template.hasResourceProperties('AWS::IAM::InstanceProfile', {
        Roles: Match.anyValue(),
      });
    });

    it('grants ECR pull permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ]),
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });
  });

  describe('EC2 Instance', () => {
    it('creates an EC2 instance with correct instance type', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 't3.micro',
      });
    });

    it('attaches the security group', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        SecurityGroupIds: Match.anyValue(),
      });
    });

    it('has an encrypted 20GB gp3 root volume', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            Ebs: Match.objectLike({
              VolumeSize: 20,
              VolumeType: 'gp3',
              Encrypted: true,
            }),
          }),
        ]),
      });
    });

    it('has user data configured', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        UserData: Match.anyValue(),
      });
    });

    it('is tagged with Name client-timesheet-app', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        Tags: Match.arrayWith([
          Match.objectLike({
            Key: 'Name',
            Value: 'client-timesheet-app',
          }),
        ]),
      });
    });
  });

  describe('Elastic IP', () => {
    it('creates an Elastic IP associated with the instance', () => {
      template.hasResourceProperties('AWS::EC2::EIP', {
        Domain: 'vpc',
        InstanceId: Match.anyValue(),
      });
    });

    it('tags the EIP correctly', () => {
      template.hasResourceProperties('AWS::EC2::EIP', {
        Tags: Match.arrayWith([
          Match.objectLike({
            Key: 'Name',
            Value: 'client-timesheet-app-eip',
          }),
        ]),
      });
    });
  });

  describe('Outputs', () => {
    it('outputs the instance ID', () => {
      template.hasOutput('InstanceId', {});
    });

    it('outputs the public IP', () => {
      template.hasOutput('InstancePublicIp', {});
    });

    it('outputs the app URL', () => {
      template.hasOutput('AppUrl', {});
    });

    it('outputs the security group ID', () => {
      template.hasOutput('SecurityGroupId', {});
    });
  });
});
