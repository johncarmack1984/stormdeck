import * as path from 'node:path';
import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_ses as ses,
  aws_ses_actions as actions,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

// Email for stormdeck.live. Deliberately a separate stack from the app:
// distinct concern, independent lifecycle. MUST deploy to us-east-2 (SES inbound
// IS supported there — no us-east-1 needed; the only us-east-1 resident in the
// whole project is the CloudFront cert).
const DOMAIN = 'stormdeck.live';
const HOSTED_ZONE_ID = 'Z05951751X7ICJA13P5AR';
const INBOUND_REGION = 'us-east-2';
// Forwards are sent FROM this (a verified-domain address SES will accept); the
// original sender goes to Reply-To. The forwarding *destination* is NOT here —
// it lives in SSM (SecureString), read by the Lambda at runtime, so it never
// touches this open-source repo or the CloudFormation template.
const MAIL_FROM = `forwarder@${DOMAIN}`;
const FORWARD_TO_PARAM = '/stormdeck/email/forward-to';
const INBOUND_PREFIX = 'inbound/';

export class StormdeckEmailStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    });

    // --- identity: the durable foundation (verified, DKIM-signed domain) ---

    // publicHostedZone auto-writes the verification TXT (_amazonses) and the
    // three DKIM CNAMEs into the zone. A future mailbox or full SES sending
    // builds on this with no re-verification.
    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(zone),
    });

    // Apex TXT record set. Route 53 allows only one TXT record-set per name, so
    // the SPF policy (authorizing Amazon SES to send) and the Google Search
    // Console domain-verification string share this single record. (Logical id
    // stays 'Spf' so CFN updates the values in place, not replacing the record.)
    new route53.TxtRecord(this, 'Spf', {
      zone,
      recordName: DOMAIN,
      values: [
        'v=spf1 include:amazonses.com ~all',
        'google-site-verification=bEdN5MsLRKcHmi5xlGSQRal-T7iLtQnR9LKO9EkAvFQ',
      ],
    });

    // DMARC — monitor mode to start; tighten after watching reports.
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: `_dmarc.${DOMAIN}`,
      values: ['v=DMARC1; p=none;'],
    });

    // --- forwarding: *@stormdeck.live -> the SSM address (default iCloud) ---

    const inbox = new s3.Bucket(this, 'Inbox', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Mail is forwarded immediately; don't hoard it.
      lifecycleRules: [{ prefix: INBOUND_PREFIX, expiration: Duration.days(7) }],
    });
    // Let SES write received mail here (the S3 receipt action also adds a
    // grant; this explicit statement makes the intent obvious and certain).
    inbox.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESPut',
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [inbox.arnForObjects(`${INBOUND_PREFIX}*`)],
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
      }),
    );

    const forwarder = new lambda.Function(this, 'Forwarder', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/email-forwarder')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        BUCKET: inbox.bucketName,
        PREFIX: INBOUND_PREFIX,
        FORWARD_TO_PARAM,
        MAIL_FROM,
      },
    });
    inbox.grantRead(forwarder, `${INBOUND_PREFIX}*`);
    forwarder.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ses:SendRawEmail'], resources: ['*'] }),
    );
    forwarder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${FORWARD_TO_PARAM}`],
      }),
    );
    // Decrypt the SecureString via the AWS-managed SSM key.
    forwarder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );

    // Catch-all rule for the domain: store the raw mail to S3, then forward.
    const ruleSet = new ses.ReceiptRuleSet(this, 'RuleSet');
    ruleSet.addRule('Forward', {
      recipients: [DOMAIN],
      actions: [
        new actions.S3({ bucket: inbox, objectKeyPrefix: INBOUND_PREFIX }),
        new actions.Lambda({ function: forwarder }),
      ],
    });

    // Only one receipt rule set can be active per account/region — activate ours.
    const activate = new cr.AwsCustomResource(this, 'ActivateRuleSet', {
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of('stormdeck-active-rule-set'),
      },
      onDelete: {
        // Deactivate so the rule set can be deleted on stack teardown.
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      // setActiveReceiptRuleSet is in the runtime's built-in SDK — no need to
      // npm-install at deploy time.
      installLatestAwsSdk: false,
    });
    activate.node.addDependency(ruleSet);

    // Route domain mail to the SES inbound endpoint for this region.
    new route53.MxRecord(this, 'Mx', {
      zone,
      recordName: DOMAIN,
      values: [{ priority: 10, hostName: `inbound-smtp.${INBOUND_REGION}.amazonaws.com` }],
    });
  }
}
