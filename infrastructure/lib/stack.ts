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

interface HabitAgilityStackProps extends cdk.StackProps {
  cert: acm.Certificate;
  authFnVersion: lambda.Version;
}

export class HabitAgilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HabitAgilityStackProps) {
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

    // ── DynamoDB ─────────────────────────────────────────────────────────────
    // Two physical tables:
    //   habit-agility-meta — single-row meta (nextSprintId, entryDateMin/Max)
    //   habit-agility-rows — sprint defs, summary rows, and per-day entries
    //                        all under one table, separated by `pk` prefix.
    // PITR enabled on both — recovery up to 35 days back protects against a
    // bad client write or orphan-sweep regression. ~$0.20/GB-month — pennies
    // for a single-user store.
    const metaTable = new dynamodb.Table(this, 'MetaTable', {
      tableName: 'habit-agility-meta',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    /** Query by partition + sort-key range — no full table Scans on read. */
    const rowsTable = new dynamodb.Table(this, 'RowsTable', {
      tableName: 'habit-agility-rows',
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
    // already auto-created it on its first invocation.)
    //
    // Env var names retained for lambda-source backward compatibility:
    //   CYCLES_TABLE_NAME points at the new meta table
    //   ENTRIES_TABLE_NAME points at the new rows table
    // The lambda source can be migrated to META_TABLE_NAME / ROWS_TABLE_NAME
    // in a follow-up patch.
    const syncFn = new lambda.Function(this, 'SyncFn', {
      functionName: 'habit-agility-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/sync')),
      memorySize: 256,
      environment: {
        CYCLES_TABLE_NAME: metaTable.tableName,
        ENTRIES_TABLE_NAME: rowsTable.tableName,
        CF_SECRET: cfSecret,
      },
      timeout: cdk.Duration.seconds(45),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    metaTable.grantReadWriteData(syncFn);
    rowsTable.grantReadWriteData(syncFn);

    const syncUrl = syncFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const syncDomain = cdk.Fn.select(2, cdk.Fn.split('/', syncUrl.url));

    // ── S3 bucket (us-west-2) ─────────────────────────────────────────────────
    // Versioning is free at this scale and undoes an accidental BucketDeployment
    // overwrite. Noncurrent versions auto-expire after 30 days to keep storage
    // bounded.
    const bucket = new s3.Bucket(this, 'AppBucket', {
      bucketName: `habit-agility-app-${this.account}`,
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
      // Dual-domain. habitagility.com is the primary; www.habitagility.com
      // and ght.vexom.io are kept so old bookmarks and the "www." reflex
      // both land on the app.
      domainNames: ['habitagility.com', 'www.habitagility.com', 'ght.vexom.io'],
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

    // ── Route 53 records ──────────────────────────────────────────────────────
    // Three A-records (all CloudFront aliases on the same distribution):
    //   - habitagility.com (apex)         — primary user-facing URL
    //   - www.habitagility.com            — "www." reflex
    //   - ght.vexom.io                    — historical bookmark, kept alive
    const vexomZone = route53.HostedZone.fromLookup(this, 'VexomZone', { domainName: 'vexom.io' });
    const habitAgilityZone = route53.HostedZone.fromLookup(this, 'HabitAgilityZone', {
      domainName: 'habitagility.com',
    });
    const cfTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'ARecordApex', {
      zone: habitAgilityZone,
      target: cfTarget,
    });
    new route53.ARecord(this, 'ARecordWww', {
      zone: habitAgilityZone,
      recordName: 'www',
      target: cfTarget,
    });
    // The legacy `ght.vexom.io` record was originally a single `ARecord` construct
    // in this stack (logical id ARecordE7B57761). Renaming the construct would
    // cause CFN to create-then-delete — but the create fails because the name is
    // already taken by the existing record. Pin the logical id so CFN treats
    // this as a no-op update on the same physical resource.
    const aRecordLegacy = new route53.ARecord(this, 'ARecordLegacy', {
      zone: vexomZone,
      recordName: 'ght',
      target: cfTarget,
    });
    (aRecordLegacy.node.defaultChild as cdk.CfnResource).overrideLogicalId('ARecordE7B57761');

    new cdk.CfnOutput(this, 'URL', { value: 'https://habitagility.com' });
    new cdk.CfnOutput(this, 'LegacyURL', { value: 'https://ght.vexom.io' });
  }
}
