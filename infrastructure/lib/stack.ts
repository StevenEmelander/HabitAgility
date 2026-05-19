import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

interface GoodHabitTrackerStackProps extends cdk.StackProps {
  cert: acm.Certificate;
  authFnVersion: lambda.Version;
}

export class GoodHabitTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GoodHabitTrackerStackProps) {
    super(scope, id, props);

    const unlockToken = this.node.tryGetContext('unlock_token') as string;
    if (!unlockToken) {
      throw new Error('Required: --context unlock_token=<your-secret-token>');
    }
    const cfSecret = crypto
      .createHash('sha256')
      .update('cf-secret:' + unlockToken)
      .digest('hex')
      .slice(0, 32);

    // ── DynamoDB: cycle definitions (date ranges, categories, habits/scoring) + per-day entries ─
    // PITR is enabled on both — point-in-time recovery up to 35 days back protects
    // against a bad client write or orphan-sweep regression. Cost is ~$0.20/GB-month
    // at this scale (pennies for a single-user store).
    const cyclesTable = new dynamodb.Table(this, 'CyclesTable', {
      tableName: 'good-habit-tracker-cycles',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    /** One partition `DAY`, sort key ISO date — Query by range (no full table Scans on read). */
    const entriesTable = new dynamodb.Table(this, 'CheckinsTable', {
      tableName: 'good-habit-tracker-day-checkins',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dateKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ── Sync Lambda (us-west-2) ───────────────────────────────────────────────
    // memorySize: 256 — at 128 MB (the default) CPU is throttled enough that
    // SDK-v3 cold starts run 600-1200 ms. 256 MB ~halves p99 latency at a small
    // per-ms surcharge and is net cheaper on this workload.
    // logRetention: ONE_MONTH — defaults to "never expire" which silently
    // accrues CloudWatch storage cost forever. (CDK warns this property is
    // deprecated in favor of `logGroup`, but the deprecated path uses a custom
    // resource that gracefully modifies an existing log group; the modern
    // `logGroup` path tries to CREATE the log group, which fails when Lambda
    // already auto-created it on its first invocation. Sticking with the
    // working API until CDK provides a migration path that doesn't require
    // manual log-group deletion.)
    const syncFn = new lambda.Function(this, 'SyncFn', {
      functionName: 'good-habit-tracker-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/sync')),
      memorySize: 256,
      environment: {
        CYCLES_TABLE_NAME: cyclesTable.tableName,
        ENTRIES_TABLE_NAME: entriesTable.tableName,
        CF_SECRET: cfSecret,
      },
      timeout: cdk.Duration.seconds(45),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    cyclesTable.grantReadWriteData(syncFn);
    entriesTable.grantReadWriteData(syncFn);

    const syncUrl = syncFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const syncDomain = cdk.Fn.select(2, cdk.Fn.split('/', syncUrl.url));

    // ── S3 bucket (us-west-2) ─────────────────────────────────────────────────
    // Versioning is free at this scale and undoes an accidental BucketDeployment
    // overwrite. Noncurrent versions auto-expire after 30 days to keep storage
    // bounded.
    const bucket = new s3.Bucket(this, 'AppBucket', {
      bucketName: `good-habit-tracker-app-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
    });
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
    bucket.grantRead(oai);

    // ── CloudFront ────────────────────────────────────────────────────────────
    const edgeLambdas: cloudfront.EdgeLambda[] = [
      { functionVersion: props.authFnVersion, eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST },
    ];

    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiORP', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Content-Type'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      // No /api/* route uses query strings (entry/sprint/trend are all path-only),
      // so drop them entirely. Smaller attack surface; nothing the Lambda would
      // actually read can ride along.
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
    });

    // Security response headers — HSTS, X-Content-Type-Options, X-Frame-Options,
    // Referrer-Policy, and a tight CSP that matches our zero-3rd-party shell
    // (no external scripts/fonts/CDNs). Applied to the default behavior; the
    // /api/* JSON behavior uses the lighter SECURITY_HEADERS managed policy.
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SiteSecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "font-src 'self'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: ['ght.vexom.io'],
      certificate: props.cert,
      defaultRootObject: 'tracker.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
        edgeLambdas,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(syncDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: { 'X-CF-Secret': cfSecret },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequestPolicy,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          edgeLambdas,
        },
      },
    });

    // ── Deploy app to S3 ──────────────────────────────────────────────────────
    new s3deploy.BucketDeployment(this, 'AppDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../app'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ── Route53 ───────────────────────────────────────────────────────────────
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: 'vexom.io' });
    new route53.ARecord(this, 'ARecord', {
      zone,
      recordName: 'ght',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, 'URL', { value: 'https://ght.vexom.io' });
  }
}
