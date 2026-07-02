#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { ServerlessStack } from '../lib/serverless-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const bootstrapStack = new BootstrapStack(app, 'ClientTimesheetBootstrapStack', {
  env,
  description: 'Bootstrap resources: S3 state bucket, DynamoDB lock table, ECR, GitHub Actions OIDC',
  githubOrg: app.node.tryGetContext('githubOrg') || 'Cognition-Partner-Workshops',
  githubRepo: app.node.tryGetContext('githubRepo') || 'hosting-client-timesheet-app',
  allowDestroy: app.node.tryGetContext('allowDestroy') !== 'false',
});

const infrastructureStack = new InfrastructureStack(app, 'ClientTimesheetInfrastructureStack', {
  env,
  description: 'EC2 infrastructure: instance, security group, IAM role, Elastic IP',
  ecrRepository: bootstrapStack.ecrRepository,
  environment: app.node.tryGetContext('environment') || 'production',
  instanceType: app.node.tryGetContext('instanceType') || 't3.micro',
  appPort: Number(app.node.tryGetContext('appPort')) || 3001,
});

const serverlessStack = new ServerlessStack(app, 'ClientTimesheetServerlessStack', {
  env,
  description: 'Serverless: DynamoDB, Lambda, API Gateway, S3 frontend, ECS SonarQube',
  appName: app.node.tryGetContext('appName') || 'client-timesheet-app',
  environment: app.node.tryGetContext('environment') || 'production',
  lambdaMemorySize: Number(app.node.tryGetContext('lambdaMemorySize')) || 256,
  lambdaTimeout: Number(app.node.tryGetContext('lambdaTimeout')) || 30,
  enableSonarqube: app.node.tryGetContext('enableSonarqube') !== 'false',
  sonarqubeCpu: Number(app.node.tryGetContext('sonarqubeCpu')) || 512,
  sonarqubeMemory: Number(app.node.tryGetContext('sonarqubeMemory')) || 2048,
});

infrastructureStack.addDependency(bootstrapStack);
