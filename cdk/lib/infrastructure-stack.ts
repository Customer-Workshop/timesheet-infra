import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface InfrastructureStackProps extends cdk.StackProps {
  ecrRepository: ecr.Repository;
  environment: string;
  instanceType: string;
  appPort: number;
}

export class InfrastructureStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: InfrastructureStackProps) {
    super(scope, id, props);

    const commonTags: Record<string, string> = {
      Environment: props.environment,
      Project: 'client-timesheet-app',
    };

    // =========================================================================
    // VPC - Use Default VPC (matching Terraform's aws_default_vpc)
    // =========================================================================

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // =========================================================================
    // Security Group
    // =========================================================================

    this.securityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      securityGroupName: 'client-timesheet-app-sg',
      description: 'Security group for Client Timesheet App',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP',
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS',
    );

    // =========================================================================
    // IAM Role for EC2 (ECR pull + SSM)
    // =========================================================================

    const ec2Role = new iam.Role(this, 'Ec2Role', {
      roleName: 'client-timesheet-ec2-role',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ECR pull policy scoped to the app repository
    ec2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRGetAuthToken',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    ec2Role.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRPullImages',
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: [props.ecrRepository.repositoryArn],
    }));

    // =========================================================================
    // EC2 Instance
    // =========================================================================

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "Starting user data script..."',
      'dnf update -y',
      'dnf install -y amazon-ssm-agent',
      'systemctl enable amazon-ssm-agent',
      'systemctl start amazon-ssm-agent',
      'dnf install -y docker',
      'systemctl start docker',
      'systemctl enable docker',
      'usermod -aG docker ec2-user',
      'dnf install -y aws-cli',
      'mkdir -p /opt/app',
      'mkdir -p /opt/app/data',
      `cat > /opt/app/deploy.sh << 'DEPLOY_SCRIPT'`,
      '#!/bin/bash',
      'set -e',
      `AWS_REGION="${cdk.Aws.REGION}"`,
      `ECR_REPOSITORY="${props.ecrRepository.repositoryUri}"`,
      `APP_PORT="${props.appPort}"`,
      'echo "Logging into ECR..."',
      'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY',
      'echo "Pulling latest image..."',
      'docker pull $ECR_REPOSITORY:latest',
      'echo "Stopping existing container..."',
      'docker stop client-timesheet-app 2>/dev/null || true',
      'docker rm client-timesheet-app 2>/dev/null || true',
      'echo "Starting new container..."',
      'docker run -d \\',
      '  --name client-timesheet-app \\',
      '  --restart unless-stopped \\',
      '  -p 80:$APP_PORT \\',
      '  -v /opt/app/data:/app/data \\',
      '  -e NODE_ENV=production \\',
      '  -e PORT=$APP_PORT \\',
      '  -e DATABASE_PATH=/app/data/timesheet.db \\',
      '  $ECR_REPOSITORY:latest',
      'echo "Cleaning up old images..."',
      'docker image prune -f',
      'echo "Deployment complete!"',
      'DEPLOY_SCRIPT',
      'chmod +x /opt/app/deploy.sh',
      `cat > /etc/systemd/system/client-timesheet-app.service << 'SERVICE'`,
      '[Unit]',
      'Description=Client Timesheet App',
      'After=docker.service',
      'Requires=docker.service',
      '',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      'ExecStart=/opt/app/deploy.sh',
      'ExecStop=/usr/bin/docker stop client-timesheet-app',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SERVICE',
      'systemctl daemon-reload',
      'systemctl enable client-timesheet-app',
      'echo "User data script completed successfully!"',
    );

    this.instance = new ec2.Instance(this, 'AppInstance', {
      vpc,
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: this.securityGroup,
      role: ec2Role,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    cdk.Tags.of(this.instance).add('Name', 'client-timesheet-app');

    // =========================================================================
    // Elastic IP
    // =========================================================================

    this.elasticIp = new ec2.CfnEIP(this, 'AppElasticIp', {
      instanceId: this.instance.instanceId,
      domain: 'vpc',
      tags: [
        { key: 'Name', value: 'client-timesheet-app-eip' },
        { key: 'Environment', value: props.environment },
        { key: 'Project', value: 'client-timesheet-app' },
      ],
    });

    // Apply common tags
    Object.entries(commonTags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // =========================================================================
    // Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'InstanceId', {
      description: 'EC2 instance ID',
      value: this.instance.instanceId,
    });

    new cdk.CfnOutput(this, 'InstancePublicIp', {
      description: 'EC2 instance public IP (Elastic IP)',
      value: this.elasticIp.attrPublicIp,
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      description: 'Application URL',
      value: `http://${this.elasticIp.attrPublicIp}`,
    });

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      description: 'Security group ID',
      value: this.securityGroup.securityGroupId,
    });
  }
}
