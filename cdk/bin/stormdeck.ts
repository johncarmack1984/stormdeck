import { App, Tags } from 'aws-cdk-lib';
import { StormdeckEmailStack } from '../lib/email-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { StormdeckStack } from '../lib/stormdeck-stack';

// Env-agnostic on purpose: synth needs no AWS account; the account/region
// are resolved by whatever profile runs `cdk deploy`.
// (The stormdeck.live cert is NOT a stack: requested once via the ACM
// CLI in us-east-1 and pinned by ARN in stormdeck-stack.ts, after
// CloudFormation's ACM wrapper proved flaky on the fresh hosted zone.)
const app = new App();
new StormdeckStack(app, 'StormdeckStack');
// Deployed once, locally, with admin creds; CI only touches StormdeckStack.
new GithubOidcStack(app, 'StormdeckGithubOidc');
// Email (SES) — deploy with AWS_REGION=us-east-2 (SES inbound region). Not in
// CI yet: it has manual prereqs (SSM forward-to secret, SES identity verify).
new StormdeckEmailStack(app, 'StormdeckEmailStack');

// One tag to find (or exclude) everything stormdeck owns when sorting
// out the rest of the account.
Tags.of(app).add('project', 'stormdeck');
