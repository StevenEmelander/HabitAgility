import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export class HabitAgilityCertStack extends cdk.Stack {
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

    // Lambda@Edge: keep memorySize at the default 128 MB — the function is
    // trivial (single SHA-256 + cookie parse) and edge billing rounds aggressively.
    // CDK can't set logRetention here: Edge logs land in the CloudWatch region
    // closest to each viewer. Retention is set on each `/aws/lambda/<region>.…`
    // log group manually in the console (or via a region-fanned-out helper);
    // tracked as an ops follow-up.
    const authFn = new lambda.Function(this, 'AuthFn', {
      functionName: 'habit-agility-auth',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(authSrcDir),
    });

    // CloudFront Lambda@Edge requires a specific version ARN (not an alias).
    // The version ARN changes when the token rotates, which updates the cross-region
    // SSM export written by ExportsWriteruswest2. This is safe as long as the deploy
    // succeeds end-to-end; a failed deploy's rollback can leave the SSM update
    // in an ambiguous state (use `cdk deploy --all` to recover).
    this.authFnVersion = authFn.currentVersion;

    // LIVE alias — stable ARN regardless of version, useful for CloudWatch alarms
    // and manual invocation. CloudFront must still reference the version ARN above.
    new lambda.Alias(this, 'AuthFnLive', {
      aliasName: 'LIVE',
      version: authFn.currentVersion,
    });
  }
}
