import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
    const cyclesTable = new dynamodb.Table(this, 'CyclesTable', {
      tableName: 'good-habit-tracker-cycles',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    /** One partition `DAY`, sort key ISO date — Query by range (no full table Scans on read). */
    const entriesTable = new dynamodb.Table(this, 'CheckinsTable', {
      tableName: 'good-habit-tracker-day-checkins',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dateKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Sync Lambda (us-west-2) ───────────────────────────────────────────────
    const syncFn = new lambda.Function(this, 'SyncFn', {
      functionName: 'good-habit-tracker-sync',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/sync')),
      environment: {
        CYCLES_TABLE_NAME: cyclesTable.tableName,
        ENTRIES_TABLE_NAME: entriesTable.tableName,
        CF_SECRET: cfSecret,
      },
      timeout: cdk.Duration.seconds(45),
    });
    cyclesTable.grantReadWriteData(syncFn);
    entriesTable.grantReadWriteData(syncFn);

    const syncUrl = syncFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    const syncDomain = cdk.Fn.select(2, cdk.Fn.split('/', syncUrl.url));

    // ── S3 bucket (us-west-2) ─────────────────────────────────────────────────
    const bucket = new s3.Bucket(this, 'AppBucket', {
      bucketName: `good-habit-tracker-app-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');
    bucket.grantRead(oai);

    // ── CloudFront ────────────────────────────────────────────────────────────
    // Two-phase deploy only: `--context temp_drop_edge_auth=true` drops Edge associations so
    // GoodHabitTrackerCert can publish a new Lambda@Edge version (exports cannot update while imported).
    const dropEdgeAuth = this.node.tryGetContext('temp_drop_edge_auth') === 'true';
    const edgeLambdas: cloudfront.EdgeLambda[] | undefined = dropEdgeAuth
      ? undefined
      : [{ functionVersion: props.authFnVersion, eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST }];

    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiORP', {
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Content-Type'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      // Sync uses ?from=YYYY-MM-DD&to=YYYY-MM-DD for ranged check-in loads.
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: ['ght.vexom.io'],
      certificate: props.cert,
      defaultRootObject: 'tracker.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        ...(edgeLambdas ? { edgeLambdas } : {}),
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
          ...(edgeLambdas ? { edgeLambdas } : {}),
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
