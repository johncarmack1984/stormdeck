import { App, Tags } from 'aws-cdk-lib';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { StormdeckStack } from '../lib/stormdeck-stack';

// Env-agnostic on purpose: synth needs no AWS account; the account/region
// are resolved by whatever profile runs `cdk deploy`.
const app = new App();
new StormdeckStack(app, 'StormdeckStack');
// Deployed once, locally, with admin creds; CI only touches StormdeckStack.
new GithubOidcStack(app, 'StormdeckGithubOidc');

// One tag to find (or exclude) everything stormdeck owns when sorting
// out the rest of the account.
Tags.of(app).add('project', 'stormdeck');
