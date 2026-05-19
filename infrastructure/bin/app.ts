#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HabitAgilityCertStack } from '../lib/cert-stack';
import { HabitAgilityStack } from '../lib/stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// ACM cert + Lambda@Edge auth must live in us-east-1 (CloudFront requirement)
const certStack = new HabitAgilityCertStack(app, 'HabitAgilityCert', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});

// Data layer and CDN in us-west-2
const mainStack = new HabitAgilityStack(app, 'HabitAgility', {
  env: { account, region: 'us-west-2' },
  crossRegionReferences: true,
  cert: certStack.cert,
  authFnVersion: certStack.authFnVersion,
});
mainStack.addDependency(certStack);
