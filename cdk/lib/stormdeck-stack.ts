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
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { RustFunction } from 'cargo-lambda-cdk';
import { Construct } from 'constructs';

// Knobs.
const PROJECT = 'stormdeck';
const NWS_AREA = ''; // state/territory code; empty = every US alert
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
      // citytile + windtex + refctex + capetex each write a fresh {snapshot}/
      // tree per run; expire old snapshots so they don't accumulate. Their
      // latest.json pointers are rewritten each run, so they stay under the age
      // cutoff and never age out.
      lifecycleRules: [
        { prefix: 'weather/citytile/', expiration: Duration.days(2) },
        { prefix: 'weather/windtex/', expiration: Duration.days(2) },
        { prefix: 'weather/refctex/', expiration: Duration.days(2) },
        { prefix: 'weather/capetex/', expiration: Duration.days(2) },
      ],
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
      // temp + windtex + refc + cape decode GFS GRIB fields (~4 MB grids,
      // several in flight; windtex also holds a u/v pair while its PNG encodes);
      // alerts is lighter.
      memorySize: 512,
      // temp samples ~57 GFS TMP fields (cities + lattice); windtex decodes u/v
      // pairs, refc/cape single REFC/CAPE fields into PNGs — all within 600s.
      timeout: Duration.seconds(600),
      environment: {
        BUCKET: bucket.bucketName,
        NWS_AREA,
        CONTACT,
        RUST_LOG: 'info',
      },
    });
    bucket.grantPut(ingest, 'weather/*');

    // Least-privilege role for manual/ops invocation of weather-ingest (e.g.
    // priming after a change). Its only permission is invoking this function;
    // the trusted principal lives in SSM so no foreign account IDs land in this
    // open-source repo (set /stormdeck/invoker-principal before deploying).
    // Resolved at deploy via valueForStringParameter, so synth stays env-agnostic.
    const invoker = new iam.Role(this, 'WeatherIngestInvoker', {
      roleName: `${PROJECT}-invoker`,
      assumedBy: new iam.ArnPrincipal(
        ssm.StringParameter.valueForStringParameter(
          this,
          '/stormdeck/invoker-principal',
        ),
      ),
      description: 'Least-privilege: invoke weather-ingest (manual prime/ops)',
    });
    ingest.grantInvoke(invoker);
    new CfnOutput(this, 'InvokerRoleArn', {
      value: invoker.roleArn,
      description: 'Assume to invoke weather-ingest (lambda:InvokeFunction only)',
    });

    // Basemap tiles change only when the pmtiles file is replaced: cache hard.
    const tilesCache = new cloudfront.CachePolicy(this, 'TilesCache', {
      comment: 'pmtiles via martin: immutable until the extract is replaced',
      minTtl: Duration.seconds(600),
      defaultTtl: Duration.seconds(86400),
      maxTtl: Duration.seconds(604800),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Weather JSON refreshes every few minutes, but immutable citytile tiles
    // (snapshot in the path) set a 1-year max-age. Keep the cap high so each
    // object's own Cache-Control drives its TTL — fresh JSON, hard-cached tiles.
    const weatherCache = new cloudfront.CachePolicy(this, 'WeatherCache', {
      comment: 'weather JSON snapshots + immutable citytile tiles',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(31_536_000),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Martin's own CORS headers don't survive the Lambda→CloudFront path, so
    // add them at the edge (like the weather feed) — lets the app run
    // cross-origin: dev against prod, a future service-demo page, or embedders.
    // Plus pin browser caching.
    const tilesHeaders = new cloudfront.ResponseHeadersPolicy(this, 'TilesHeaders', {
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowOrigins: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowHeaders: ['*'],
        originOverride: true,
      },
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
      // The S3 origins can't ListBucket, so a missing key surfaces as 403
      // AccessDenied; map it to a real 404 (a page the web deploy ships) so
      // crawlers and users get the right status instead of AccessDenied XML.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(1),
        },
      ],
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
    // Bing Webmaster Tools ownership verification — Bing re-checks the
    // record periodically, so it lives in IaC like the ACM records above.
    new route53.CnameRecord(this, 'BingVerify', {
      zone,
      recordName: '90df4a501a46bca2c63fdbd82d582345',
      domainName: 'verify.bing.com.',
    });

    // EventBridge Scheduler triggers (14M invocations/month free tier). Every
    // weather job is free GFS GRIB from NODD (no per-call limit) plus the public
    // NWS alerts feed, so the cadence is bounded by freshness, not API quotas;
    // temp + windtex + refc + cape refresh once per GFS cycle window.
    const jobs: Array<[string, Duration]> = [
      ['alerts', Duration.minutes(5)],
      ['temp', Duration.hours(6)],
      ['windtex', Duration.hours(6)],
      ['refc', Duration.hours(6)],
      ['cape', Duration.hours(6)],
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
