# Terraform to AWS CDK Migration Notes

## Overview

This document maps the original Terraform infrastructure (in `terraform/`) to the equivalent AWS CDK TypeScript implementation (in `cdk/`). The CDK implementation preserves all resources, security groups, IAM roles, and networking configuration.

## Stack Mapping

| Terraform Module | CDK Stack | Description |
|-----------------|-----------|-------------|
| `terraform/bootstrap/` | `BootstrapStack` | S3 state bucket, DynamoDB lock table, ECR, GitHub OIDC |
| `terraform/infrastructure/` | `InfrastructureStack` | EC2 instance, security group, IAM role, Elastic IP |
| `terraform/serverless/` | `ServerlessStack` | DynamoDB tables, Lambda, API Gateway, S3 frontend, ECS SonarQube |

## Resource Mapping

### Bootstrap Stack

| Terraform Resource | CDK Construct | Notes |
|-------------------|---------------|-------|
| `aws_s3_bucket.terraform_state` | `s3.Bucket` | Versioned, SSE-S3, block all public access |
| `aws_s3_bucket_versioning.terraform_state` | `versioned: true` property | Inline in Bucket construct |
| `aws_s3_bucket_server_side_encryption_configuration.terraform_state` | `encryption: S3_MANAGED` | Inline in Bucket construct |
| `aws_s3_bucket_public_access_block.terraform_state` | `blockPublicAccess: BLOCK_ALL` | Inline in Bucket construct |
| `aws_dynamodb_table.terraform_locks` | `dynamodb.Table` | PAY_PER_REQUEST, hash key: LockID |
| `aws_ecr_repository.app` | `ecr.Repository` | Scan on push, mutable tags, lifecycle: keep 10 |
| `aws_ecr_lifecycle_policy.app` | `lifecycleRules` property | Inline in Repository construct |
| `aws_iam_openid_connect_provider.github_actions` | `iam.OpenIdConnectProvider` | GitHub Actions OIDC |
| `aws_iam_role.github_actions_deploy` | `iam.Role` | WebIdentity principal with OIDC conditions |
| `aws_iam_role_policy.github_actions_ecr` | `role.addToPolicy()` | ECR push/pull statements |
| `aws_iam_role_policy.github_actions_ec2` | `role.addToPolicy()` | EC2 describe statements |
| `aws_iam_role_policy.github_actions_ssm` | `role.addToPolicy()` | SSM send command statements |
| `aws_iam_role_policy.github_actions_lambda` | `role.addToPolicy()` | Lambda update statements |
| `aws_iam_role_policy.github_actions_s3` | `role.addToPolicy()` | S3 frontend + state access |
| `aws_iam_role_policy.github_actions_ecs` | `role.addToPolicy()` | ECS/SonarQube statements |

### Infrastructure Stack

| Terraform Resource | CDK Construct | Notes |
|-------------------|---------------|-------|
| `aws_default_vpc.default` | `ec2.Vpc.fromLookup(isDefault: true)` | Uses default VPC |
| `aws_default_subnet.default` | `vpcSubnets: { subnetType: PUBLIC }` | CDK selects public subnets automatically |
| `aws_security_group.app` | `ec2.SecurityGroup` | HTTP(80), HTTPS(443) ingress, all egress |
| `aws_iam_role.ec2_role` | `iam.Role` | EC2 service principal |
| `aws_iam_role_policy.ecr_policy` | `role.addToPolicy()` | ECR auth + pull |
| `aws_iam_role_policy_attachment.ssm_managed_instance` | `managedPolicies: [AmazonSSMManagedInstanceCore]` | SSM managed policy |
| `aws_iam_instance_profile.ec2_profile` | Auto-created by `ec2.Instance` | CDK auto-creates when role is specified |
| `aws_instance.app` | `ec2.Instance` | t3.micro, AL2023, gp3 20GB encrypted |
| `data.aws_ami.amazon_linux_2023` | `ec2.MachineImage.latestAmazonLinux2023()` | CDK resolves AMI at synth/deploy time |
| `aws_eip.app` | `ec2.CfnEIP` | L1 construct for direct instance association |
| `templatefile("user_data.sh")` | `ec2.UserData.forLinux().addCommands()` | Inline user data commands |

### Serverless Stack

| Terraform Resource | CDK Construct | Notes |
|-------------------|---------------|-------|
| `aws_dynamodb_table.users` | `dynamodb.Table` | PAY_PER_REQUEST, key: email |
| `aws_dynamodb_table.clients` | `dynamodb.Table` + GSI | GSI: user_email-index |
| `aws_dynamodb_table.work_entries` | `dynamodb.Table` + 2 GSIs | GSIs: user_email-index, client_id-index |
| `aws_s3_bucket.frontend` | `s3.Bucket` | Website hosting, public read, SPA error doc |
| `aws_s3_bucket_website_configuration.frontend` | `websiteIndexDocument` / `websiteErrorDocument` | Inline properties |
| `aws_s3_bucket_public_access_block.frontend` | `blockPublicAccess` property | All false for public hosting |
| `aws_s3_bucket_policy.frontend` | `publicReadAccess: true` | CDK generates the policy automatically |
| `aws_iam_role.lambda_role` | `iam.Role` | Lambda service principal |
| `aws_iam_role_policy.lambda_dynamodb` | `role.addToPolicy()` | DynamoDB CRUD on all 3 tables + indexes |
| `aws_iam_role_policy_attachment.lambda_logs` | `managedPolicies: [AWSLambdaBasicExecutionRole]` | CloudWatch logs |
| `aws_lambda_function.api` | `lambda.Function` | Node.js 20, 256MB, 30s timeout |
| `aws_lambda_function_url.api` | `function.addFunctionUrl()` | NONE auth, full CORS |
| `aws_apigatewayv2_api.api` | `apigatewayv2.HttpApi` | HTTP API with CORS |
| `aws_apigatewayv2_integration.lambda` | `HttpLambdaIntegration` | AWS_PROXY, payload v2.0 |
| `aws_apigatewayv2_route.default` | `httpApi.addRoutes()` | Catch-all route `/{proxy+}` + root `/` |
| `aws_apigatewayv2_stage.default` | Auto-created `$default` stage | CDK auto-creates with auto-deploy |
| `aws_lambda_permission.api_gateway` | Auto-created by integration | CDK handles permissions automatically |
| `aws_security_group.sonarqube` | `ec2.SecurityGroup` | Port 9000 ingress (conditional) |
| `aws_ecs_cluster.sonarqube` | `ecs.Cluster` | Container Insights disabled |
| `aws_ecs_cluster_capacity_providers.sonarqube` | `enableFargateCapacityProviders: true` | FARGATE_SPOT |
| `aws_iam_role.ecs_task_execution` | Auto-created by `FargateTaskDefinition` | CDK auto-creates execution role |
| `aws_iam_role_policy_attachment.ecs_task_execution` | Auto-attached | CDK attaches ECS task execution policy |
| `aws_iam_role_policy.ecs_cloudwatch_logs` | Auto-granted by `LogDrivers.awsLogs()` | CDK handles log permissions |
| `aws_efs_file_system.sonarqube` | `efs.FileSystem` | Unencrypted, IA after 7 days |
| `aws_security_group.efs` | `ec2.SecurityGroup` | NFS (2049) from SonarQube SG |
| `aws_efs_mount_target.sonarqube` | Auto-created by EFS construct | CDK creates mount targets in specified subnets |
| `aws_ecs_task_definition.sonarqube` | `ecs.FargateTaskDefinition` | 512 CPU, 2048 MB |
| `aws_ecs_service.sonarqube` | `ecs.FargateService` | FARGATE_SPOT, public IP, desired=1 |

## Behavioral Differences

### 1. Resource Naming

- **Terraform**: Resources get exact names as specified (e.g., `client-timesheet-app-sg`)
- **CDK**: Resources get CloudFormation logical IDs with hash suffixes. Physical names are preserved where explicitly set via `securityGroupName`, `roleName`, `tableName`, etc.

### 2. State Management

- **Terraform**: Uses S3 backend with DynamoDB locking
- **CDK**: Uses CloudFormation stacks (state managed by AWS). The S3/DynamoDB resources are preserved in the CDK stack for backward compatibility if Terraform modules are still in use.

### 3. Instance Profile

- **Terraform**: Explicitly creates `aws_iam_instance_profile`
- **CDK**: Auto-creates an instance profile when an IAM role is attached to an EC2 instance

### 4. Lambda Permissions for API Gateway

- **Terraform**: Explicit `aws_lambda_permission` resource
- **CDK**: Automatically adds the Lambda permission when using `HttpLambdaIntegration`

### 5. ECS Task Execution Role

- **Terraform**: Explicit role + policy attachment
- **CDK**: Auto-created with `FargateTaskDefinition`; CloudWatch log permissions auto-granted via `LogDrivers.awsLogs()`

### 6. S3 Bucket Policy for Frontend

- **Terraform**: Explicit `aws_s3_bucket_policy` with PublicRead statement
- **CDK**: Uses `publicReadAccess: true` which generates an equivalent policy

### 7. AMI Selection

- **Terraform**: `data.aws_ami` with filter `al2023-ami-*-x86_64`
- **CDK**: `MachineImage.latestAmazonLinux2023({ cpuType: X86_64 })` — resolved at deploy time via SSM parameter

### 8. API Gateway Routing

- **Terraform**: Single `$default` route catches all requests
- **CDK**: Uses `/{proxy+}` and `/` routes (functionally equivalent; HTTP API routes all to Lambda)

### 9. Conditional Resources (SonarQube)

- **Terraform**: Uses `count` parameter (e.g., `count = var.enable_sonarqube ? 1 : 0`)
- **CDK**: Uses TypeScript `if` statement in the constructor

### 10. EFS Mount Targets

- **Terraform**: Explicit `aws_efs_mount_target` with count
- **CDK**: The `efs.FileSystem` construct creates mount targets automatically in the VPC subnets; the security group is specified at creation

### 11. Removal Policy

- **Terraform**: `force_destroy = var.allow_destroy` on S3/ECR
- **CDK**: `removalPolicy: DESTROY` + `autoDeleteObjects: true` (adds a custom Lambda to empty buckets before deletion)

## Variables → Context Values

CDK uses "context values" instead of Terraform variables. They can be set in `cdk.json` or via `-c key=value` CLI flags.

| Terraform Variable | CDK Context Key | Default |
|-------------------|-----------------|---------|
| `aws_region` | `CDK_DEFAULT_REGION` env var | `us-east-1` |
| `allow_destroy` | `allowDestroy` | `true` |
| `github_org` | `githubOrg` | `Cognition-Partner-Workshops` |
| `github_repo` | `githubRepo` | `hosting-client-timesheet-app` |
| `environment` | `environment` | `production` |
| `instance_type` | `instanceType` | `t3.micro` |
| `app_port` | `appPort` | `3001` |
| `ecr_repository_url` / `ecr_repository_arn` | Cross-stack reference from BootstrapStack | Automatic |
| `app_name` | `appName` | `client-timesheet-app` |
| `lambda_memory_size` | `lambdaMemorySize` | `256` |
| `lambda_timeout` | `lambdaTimeout` | `30` |
| `enable_sonarqube` | `enableSonarqube` | `true` |
| `sonarqube_cpu` | `sonarqubeCpu` | `512` |
| `sonarqube_memory` | `sonarqubeMemory` | `2048` |

## Verification Steps

### Prerequisites

```bash
cd cdk
npm install
```

### 1. Build and Type-Check

```bash
npm run build
```

### 2. Run Unit Tests

```bash
npm test
```

### 3. Synthesize CloudFormation Templates

```bash
npx cdk synth
```

This generates CloudFormation JSON in `cdk.out/`. Review the templates to confirm resources match expectations.

### 4. Diff Against Existing Infrastructure

If deploying alongside existing Terraform-managed resources:

```bash
npx cdk diff
```

### 5. Deploy (with caution)

```bash
# Deploy bootstrap stack first
npx cdk deploy ClientTimesheetBootstrapStack

# Then infrastructure
npx cdk deploy ClientTimesheetInfrastructureStack

# Then serverless
npx cdk deploy ClientTimesheetServerlessStack
```

### 6. Post-Deployment Verification

- Verify EC2 instance is running with correct security group rules
- Confirm Elastic IP is associated
- Check Lambda function is deployed with correct environment variables
- Verify API Gateway endpoint responds
- Confirm DynamoDB tables exist with correct indexes
- If SonarQube enabled, verify ECS service is running on Fargate Spot
- Test SSM Session Manager connectivity to EC2 instance

### 7. Rollback Plan

If issues arise during migration:
1. The original Terraform state is untouched — resources can still be managed by Terraform
2. CDK stacks can be destroyed independently: `npx cdk destroy <StackName>`
3. For a gradual migration, deploy CDK stacks to a separate environment first
