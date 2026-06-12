import * as path from 'node:path';
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

// Knobs.
const PROJECT = 'stormdeck';
const NWS_AREA = ''; // state/territory code; empty = every US alert
const BBOX = '-98.2,31.8,-95.8,33.6'; // match the tile extract (DFW)
const CONTACT = 'github.com/johncarmack1984/stormdeck';
const TILES_KEY = 'pmtiles/region.pmtiles';
const WORLD_KEY = 'pmtiles/world.pmtiles';

// stormdeck.live — registered in this account via Route 53 Domains
// (2026-06-12); registration auto-created the hosted zone, referenced
// here by id so synth stays env-agnostic (no fromLookup). The web app
// lives on GitHub Pages, so the apex points at Pages' anycast set:
// https://docs.github.com/pages → "managing a custom domain".
const DOMAIN = 'stormdeck.live';
const HOSTED_ZONE_ID = 'Z05419711L0SGJDJ4NEL1';
const GITHUB_PAGES_A = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];
const GITHUB_PAGES_AAAA = [
  '2606:50c0:8000::153',
  '2606:50c0:8001::153',
  '2606:50c0:8002::153',
  '2606:50c0:8003::153',
];

const MARTIN_ZIP = path.join(__dirname, '../../build/martin-lambda.zip');
const WEATHER_ZIP = path.join(
  __dirname,
  '../../crates/target/lambda/weather-ingest/bootstrap.zip',
);

export class StormdeckStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // One private bucket: pmtiles/ read by martin via the S3 API,
    // weather/ written by weather-ingest and served through CloudFront.
    const bucket = new s3.Bucket(this, 'Data', {
      bucketName: `${PROJECT}-${Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // martin ≥ v0.14 serves Lambda events natively; the zip is the upstream
    // prebuilt binary plus a bootstrap script (scripts/build-martin-lambda.sh).
    const martin = new lambda.Function(this, 'Martin', {
      functionName: `${PROJECT}-martin`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset(MARTIN_ZIP),
      memorySize: 512,
      timeout: Duration.seconds(30),
      // Tile serving keeps working even if something else in the account
      // exhausts the shared unreserved concurrency pool.
      reservedConcurrentExecutions: 25,
      environment: {
        TILE_SOURCES: `s3://${bucket.bucketName}/${TILES_KEY} s3://${bucket.bucketName}/${WORLD_KEY}`,
        RUST_LOG: 'info',
      },
    });
    bucket.grantRead(martin, 'pmtiles/*');
    const martinUrl = martin.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    const ingest = new lambda.Function(this, 'WeatherIngest', {
      functionName: `${PROJECT}-weather-ingest`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset(WEATHER_ZIP),
      memorySize: 256,
      // The global job paces ~12 Open-Meteo batches 15s apart (+ 429 backoff).
      timeout: Duration.seconds(600),
      environment: {
        BUCKET: bucket.bucketName,
        NWS_AREA,
        BBOX,
        CONTACT,
        RUST_LOG: 'info',
      },
    });
    bucket.grantPut(ingest, 'weather/*');

    // Basemap tiles change only when the pmtiles file is replaced: cache hard.
    const tilesCache = new cloudfront.CachePolicy(this, 'TilesCache', {
      comment: 'pmtiles via martin: immutable until the extract is replaced',
      minTtl: Duration.seconds(600),
      defaultTtl: Duration.seconds(86400),
      maxTtl: Duration.seconds(604800),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Weather snapshots are regenerated every few minutes: cache briefly.
    const weatherCache = new cloudfront.CachePolicy(this, 'WeatherCache', {
      comment: 'weather JSON snapshots',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(300),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Martin emits its own CORS headers; we only pin down browser caching.
    const tilesHeaders = new cloudfront.ResponseHeadersPolicy(this, 'TilesHeaders', {
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: 'public, max-age=3600', override: false },
        ],
      },
    });

    // S3 sends no CORS headers, so CloudFront adds them for the weather feed.
    const weatherHeaders = new cloudfront.ResponseHeadersPolicy(this, 'WeatherHeaders', {
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowOrigins: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowHeaders: ['*'],
        originOverride: true,
      },
    });

    // Single distribution, both on always-free tiers:
    //   default behavior  -> martin Lambda function URL (tiles, tilejson, /catalog)
    //   weather/*         -> S3 weather snapshots
    // withOriginAccessControl wires the OACs, the lambda invoke permission,
    // and the bucket policy (the L2 grants the distribution GetObject on all
    // objects, conditioned on this distribution's ARN; only the weather/*
    // behavior routes to S3, so the reachable surface is weather/* anyway).
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      comment: PROJECT,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(martinUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: tilesCache,
        // Function URLs 403 if the Host header is forwarded.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: tilesHeaders,
      },
      additionalBehaviors: {
        'weather/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: weatherCache,
          responseHeadersPolicy: weatherHeaders,
        },
      },
    });

    // withOriginAccessControl grants only lambda:InvokeFunctionUrl, but the
    // OAC docs require lambda:InvokeFunction for the service principal too —
    // without it the signed origin requests 403 (AccessDeniedException).
    martin.addPermission('AllowCloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.formatArn({
        service: 'cloudfront',
        region: '',
        resource: `distribution/${cdn.distributionId}`,
      }),
    });

    // DNS: apex + www → GitHub Pages, which serves the web app and
    // provisions the Let's Encrypt cert for the custom domain.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    });
    new route53.ARecord(this, 'PagesA', {
      zone,
      target: route53.RecordTarget.fromIpAddresses(...GITHUB_PAGES_A),
    });
    new route53.AaaaRecord(this, 'PagesAaaa', {
      zone,
      target: route53.RecordTarget.fromIpAddresses(...GITHUB_PAGES_AAAA),
    });
    new route53.CnameRecord(this, 'PagesWww', {
      zone,
      recordName: 'www',
      domainName: 'johncarmack1984.github.io',
    });

    // EventBridge Scheduler triggers (14M invocations/month free tier).
    // Each lattice point is one Open-Meteo API call; together these rates
    // stay under their 10k/day non-commercial tier (~9k/day).
    const jobs: Array<[string, Duration]> = [
      ['alerts', Duration.minutes(5)],
      ['grid', Duration.minutes(30)],
      ['global', Duration.hours(6)],
    ];
    for (const [job, every] of jobs) {
      new scheduler.Schedule(this, `Schedule-${job}`, {
        scheduleName: `${PROJECT}-${job}`,
        schedule: scheduler.ScheduleExpression.rate(every),
        target: new targets.LambdaInvoke(ingest, {
          input: scheduler.ScheduleTargetInput.fromObject({ job }),
        }),
      });
    }

    new CfnOutput(this, 'SiteUrl', { value: `https://${DOMAIN}` });
    new CfnOutput(this, 'ApiBase', {
      value: `https://${cdn.distributionDomainName}`,
      description: 'Set this as the API_BASE repo variable for the Pages build',
    });
    new CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Data bucket (pmtiles/ + weather/)',
    });
    new CfnOutput(this, 'MartinFunctionUrl', {
      value: martinUrl.url,
      description: 'Direct martin URL (IAM-auth; for debugging via curl --aws-sigv4)',
    });
  }
}
