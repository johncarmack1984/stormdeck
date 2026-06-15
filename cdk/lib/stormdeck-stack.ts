import * as path from 'node:path';
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_route53_targets as r53targets,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as targets,
} from 'aws-cdk-lib';
import { RustFunction } from 'cargo-lambda-cdk';
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
// here by id so synth stays env-agnostic (no fromLookup).
const DOMAIN = 'stormdeck.live';
const HOSTED_ZONE_ID = 'Z05951751X7ICJA13P5AR';
// Issued by the StormdeckCert stack (us-east-1 — CloudFront cert rule);
// pinned by ARN so this stack stays env-agnostic and synths offline.
const CERT_ARN_US_EAST_1 =
  'arn:aws:acm:us-east-1:236608207327:certificate/e3a334a5-ee53-4d52-bcb4-80a327baa81d';

const MARTIN_ZIP = path.join(__dirname, '../../build/martin-lambda.zip');
// weather-ingest compiles at synth via cargo-lambda-cdk (RustFunction),
// so there's no prebuilt zip to stage — just the workspace manifest.
const CRATES_MANIFEST = path.join(__dirname, '../../crates/Cargo.toml');

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
      // No reservedConcurrentExecutions: this account is single-tenant (the
      // whole point of the dedicated account), so there's no shared pool to
      // protect against — martin gets the account's full concurrency. New
      // accounts also start at a 10-execution limit, below which any
      // reservation is rejected; raise the Lambda quota if tile traffic
      // ever needs more headroom.
      environment: {
        TILE_SOURCES: `s3://${bucket.bucketName}/${TILES_KEY} s3://${bucket.bucketName}/${WORLD_KEY}`,
        RUST_LOG: 'info',
      },
    });
    bucket.grantRead(martin, 'pmtiles/*');
    const martinUrl = martin.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // cargo-lambda-cdk compiles weather-ingest at synth (cargo lambda —
    // locally when it's on PATH, else Docker). binaryName is required
    // because the manifest is a workspace; ARM_64 here drives both the
    // --arm64 build flag and the function architecture. Runtime defaults
    // to provided.al2023 and the handler to bootstrap.
    const ingest = new RustFunction(this, 'WeatherIngest', {
      functionName: `${PROJECT}-weather-ingest`,
      manifestPath: CRATES_MANIFEST,
      binaryName: 'weather-ingest',
      architecture: lambda.Architecture.ARM_64,
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

    // Single distribution, one origin set, everything same-origin under
    // stormdeck.live (which is what lets the browser skip CORS entirely):
    //   default behavior          -> S3 site/ (the built web app)
    //   catalog, region*, world*  -> martin Lambda function URL
    //   weather/*                 -> S3 weather snapshots
    // withOriginAccessControl wires the OACs, the lambda invoke permission,
    // and the bucket policy (the L2 grants the distribution GetObject on all
    // objects, conditioned on this distribution's ARN).
    const martinOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(martinUrl);
    const martinBehavior: cloudfront.BehaviorOptions = {
      origin: martinOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: tilesCache,
      // Function URLs 403 if the Host header is forwarded.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: tilesHeaders,
    };
    // CloudFront aliases are globally unique across distributions, so a new
    // distribution can't claim stormdeck.live/www while the old one still owns
    // them. STORMDECK_SKIP_CUSTOM_DOMAIN=1 stands this stack up on its
    // *.cloudfront.net domain (no aliases/cert) for the migration buildout;
    // the aliases + cert are attached at cutover. Default = production behavior.
    const customDomain = process.env.STORMDECK_SKIP_CUSTOM_DOMAIN !== '1';
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      comment: PROJECT,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      domainNames: customDomain ? [DOMAIN, `www.${DOMAIN}`] : undefined,
      certificate: customDomain
        ? acm.Certificate.fromCertificateArn(this, 'SiteCert', CERT_ARN_US_EAST_1)
        : undefined,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // deploy-web syncs the built app here: hashed assets immutable,
        // index.html no-cache (browser caching rides those object headers;
        // CachingOptimized honors origin Cache-Control).
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originPath: '/site',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        catalog: martinBehavior,
        'region*': martinBehavior,
        'world*': martinBehavior,
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

    // DNS: apex + www → this distribution. (Logical ids still say Pages
    // from the brief GitHub Pages era — kept so the cutover updated the
    // live records in place instead of delete/create racing them.)
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    });
    const cdnAlias = route53.RecordTarget.fromAlias(
      new r53targets.CloudFrontTarget(cdn),
    );
    new route53.ARecord(this, 'PagesA', { zone, target: cdnAlias });
    new route53.AaaaRecord(this, 'PagesAaaa', { zone, target: cdnAlias });
    new route53.CnameRecord(this, 'PagesWww', {
      zone,
      recordName: 'www',
      domainName: cdn.distributionDomainName,
    });
    // ACM validation for the pinned us-east-1 cert — renewal re-checks
    // these forever, so they belong in IaC. (The cert was requested via
    // CLI after CloudFormation's ACM wrapper failed on this fresh zone;
    // gotcha for next time: ACM honors CAA through CNAMEs, so www could
    // not validate while it still pointed at github.io.)
    new route53.CnameRecord(this, 'CertValidationApex', {
      zone,
      recordName: '_2f33ac9e042afc2d5992bbdbff0a5a03',
      domainName:
        '_dc990f9e70606bb0f52278a70925308d.jkddzztszm.acm-validations.aws.',
    });
    new route53.CnameRecord(this, 'CertValidationWww', {
      zone,
      recordName: '_52516c0539ceaca7c1893d81314f9582.www',
      domainName:
        '_9fa95b9ad4ef666e498d1b9de17ba1f8.jkddzztszm.acm-validations.aws.',
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
    new CfnOutput(this, 'DistributionId', {
      value: cdn.distributionId,
      description: 'Set as the DISTRIBUTION_ID repo variable (deploy-web invalidations)',
    });
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
