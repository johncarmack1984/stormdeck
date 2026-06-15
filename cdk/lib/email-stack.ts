import {
  Stack,
  StackProps,
  aws_route53 as route53,
  aws_ses as ses,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

// Email for stormdeck.live. Deliberately a separate stack from the app:
// distinct concern, independent lifecycle. Lives in us-east-2 alongside the
// app (SES inbound IS supported there — no us-east-1 needed; the only
// us-east-1 resident in the whole project is the CloudFront cert).
const DOMAIN = 'stormdeck.live';
const HOSTED_ZONE_ID = 'Z05951751X7ICJA13P5AR';

export class StormdeckEmailStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: DOMAIN,
    });

    // SES domain identity + Easy DKIM. publicHostedZone auto-writes the
    // verification TXT (_amazonses) and the three DKIM CNAMEs into the zone.
    // This is the durable foundation: a future company mailbox or full SES
    // sending just builds on an already-verified, DKIM-signed domain — no
    // migration pain later.
    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(zone),
    });

    // SPF — authorize Amazon SES to send for the domain. (~all = soft-fail
    // while we settle in; tighten to -all once everything is verified.)
    new route53.TxtRecord(this, 'Spf', {
      zone,
      recordName: DOMAIN,
      values: ['v=spf1 include:amazonses.com ~all'],
    });

    // DMARC — start in monitor mode (p=none); tighten to quarantine/reject
    // after watching aggregate reports.
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: `_dmarc.${DOMAIN}`,
      values: ['v=DMARC1; p=none;'],
    });
  }
}
