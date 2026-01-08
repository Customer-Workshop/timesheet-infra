# Client Timesheet App - AWS Infrastructure

This repository contains the infrastructure-as-code (Terraform) and CI/CD configuration (GitHub Actions) for deploying the Client Timesheet App to AWS.

## Architecture Overview

The simplest and most cost-effective AWS hosting solution for this application:

- **EC2 t3.micro instance** (~$8/month, free tier eligible for 12 months)
- **Docker container** running the full-stack application
- **SQLite database** stored on EBS volume for persistence
- **Elastic IP** for consistent public address
- **ECR** for Docker image storage

The backend serves both the API and the static frontend files, eliminating the need for separate hosting services.

## Cost Estimate

| Resource | Monthly Cost |
|----------|-------------|
| EC2 t3.micro | ~$8.35 (or free with free tier) |
| EBS 20GB gp3 | ~$1.60 |
| Elastic IP | Free (when attached to running instance) |
| ECR | ~$0.10/GB stored |
| Data Transfer | ~$0.09/GB (first 1GB free) |
| **Total** | **~$10-15/month** (or ~$2/month with free tier) |

## Prerequisites

Before setting up the CD pipeline, you need:

1. **AWS Account** with appropriate permissions
2. **GitHub repository access** to both this repo and the application repo
3. **SSH key pair** for EC2 access

## Initial Setup Instructions

### Step 1: Bootstrap AWS Infrastructure

The bootstrap step creates the S3 bucket for Terraform state, DynamoDB table for state locking, and ECR repository. This only needs to be done once.

```bash
cd terraform/bootstrap

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Apply the bootstrap infrastructure
terraform apply
```

Save the outputs - you'll need them for the next steps:
- `terraform_state_bucket` - S3 bucket name for Terraform state
- `ecr_repository_url` - ECR repository URL for Docker images

### Step 2: Generate SSH Key Pair

Generate an SSH key pair for EC2 access:

```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/client-timesheet-deployer -N ""
```

This creates:
- `~/.ssh/client-timesheet-deployer` - Private key (keep secure!)
- `~/.ssh/client-timesheet-deployer.pub` - Public key

### Step 3: Configure GitHub Secrets

In your GitHub repository settings, add the following secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `AWS_ACCESS_KEY_ID` | AWS access key for deployments | Create IAM user with EC2, ECR, S3 permissions |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | Same IAM user |
| `EC2_SSH_PRIVATE_KEY` | Private SSH key for EC2 access | Contents of `~/.ssh/client-timesheet-deployer` |
| `EC2_SSH_PUBLIC_KEY` | Public SSH key | Contents of `~/.ssh/client-timesheet-deployer.pub` |
| `ECR_REPOSITORY_URL` | ECR repository URL | From bootstrap output |
| `GH_PAT` | GitHub Personal Access Token | Create PAT with `repo` scope to access the app repo |

### Step 4: Deploy Infrastructure

After configuring secrets, deploy the main infrastructure:

```bash
cd terraform/infrastructure

# Initialize Terraform with the S3 backend
terraform init

# Set required variables
export TF_VAR_ssh_public_key="$(cat ~/.ssh/client-timesheet-deployer.pub)"
export TF_VAR_ecr_repository_url="<ECR_REPOSITORY_URL_FROM_BOOTSTRAP>"

# Review the plan
terraform plan

# Apply the infrastructure
terraform apply
```

### Step 5: Trigger First Deployment

Once the infrastructure is deployed:

1. Push to the `main` branch to trigger the CD pipeline
2. Or manually trigger the workflow from GitHub Actions

The workflow will:
1. Build the Docker image with the application
2. Push to ECR
3. SSH into the EC2 instance
4. Pull and run the new container

## Directory Structure

```
.
├── .github/
│   └── workflows/
│       └── deploy.yml          # CD pipeline
├── docker/
│   ├── Dockerfile              # Multi-stage Docker build
│   └── overrides/              # Production-ready server files
│       ├── server.js           # Modified server for static file serving
│       └── database/
│           └── init.js         # File-based SQLite support
├── terraform/
│   ├── bootstrap/              # One-time setup (S3, DynamoDB, ECR)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── infrastructure/         # Main infrastructure (EC2, Security Groups)
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── user_data.sh        # EC2 initialization script
└── README.md
```

## CD Pipeline

The GitHub Actions workflow (`deploy.yml`) runs on:
- Push to `main` branch
- Manual trigger via workflow_dispatch

Pipeline stages:
1. **Build and Push**: Builds Docker image and pushes to ECR
2. **Deploy**: SSHs into EC2 and runs the deployment script
3. **Health Check**: Verifies the application is running

## Accessing the Application

After deployment, access the application at:
```
http://<ELASTIC_IP>
```

Get the Elastic IP from Terraform outputs:
```bash
cd terraform/infrastructure
terraform output instance_public_ip
```

## Troubleshooting

### Check EC2 Logs
```bash
ssh -i ~/.ssh/client-timesheet-deployer ec2-user@<ELASTIC_IP>
sudo cat /var/log/user-data.log
docker logs client-timesheet-app
```

### Manual Deployment
```bash
ssh -i ~/.ssh/client-timesheet-deployer ec2-user@<ELASTIC_IP>
sudo /opt/app/deploy.sh
```

### Check Container Status
```bash
ssh -i ~/.ssh/client-timesheet-deployer ec2-user@<ELASTIC_IP>
docker ps
docker logs client-timesheet-app
```

## Security Considerations

- SSH access is open to all IPs (0.0.0.0/0) - consider restricting to your IP range
- The application uses email-only authentication - consider implementing proper auth for production
- SQLite data is stored on EBS - consider regular backups
- HTTPS is not configured - consider adding an Application Load Balancer with ACM certificate

## Scaling Considerations

If you need to scale beyond a single instance:
1. Move SQLite to RDS (PostgreSQL/MySQL)
2. Add Application Load Balancer
3. Use Auto Scaling Group
4. Consider ECS Fargate for container orchestration
