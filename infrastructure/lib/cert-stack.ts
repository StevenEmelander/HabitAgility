import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export class CertStack extends cdk.Stack {
  readonly cert: acm.Certificate;
  readonly authFnVersion: lambda.Version;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const unlockToken = this.node.tryGetContext('unlock_token') as string;
    if (!unlockToken) {
      throw new Error('Required: --context unlock_token=<your-secret-token>');
    }
    const unlockHash = crypto.createHash('sha256').update(unlockToken).digest('hex');

    // ACM cert — must be in us-east-1 for CloudFront
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: 'vexom.io' });
    this.cert = new acm.Certificate(this, 'Cert', {
      domainName: 'ght.vexom.io',
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Lambda@Edge — must be in us-east-1; no environment variables allowed
    const authSrcDir = path.join(__dirname, '../../.cdk-gen/auth');
    fs.mkdirSync(authSrcDir, { recursive: true });
    const authTemplate = fs.readFileSync(path.join(__dirname, '../lambdas/auth/index.js'), 'utf8');
    // Replace only the constant line so a stray "__UNLOCK_HASH__" in a comment cannot steal the substitution.
    const authOut = authTemplate.replace(
      "const UNLOCK_HASH = '__UNLOCK_HASH__';",
      `const UNLOCK_HASH = '${unlockHash}';`,
    );
    if (authOut.includes('__UNLOCK_HASH__')) {
      throw new Error('Auth template still contains __UNLOCK_HASH__ after substitution');
    }
    fs.writeFileSync(path.join(authSrcDir, 'index.js'), authOut);

    const authFn = new lambda.Function(this, 'AuthFn', {
      functionName: 'good-habit-tracker-auth',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(authSrcDir),
    });
    this.authFnVersion = authFn.currentVersion;
  }
}
