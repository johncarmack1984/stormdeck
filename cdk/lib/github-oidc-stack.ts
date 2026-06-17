import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  aws_iam as iam,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const GITHUB_REPO = 'johncarmack1984/stormdeck';

/**
 * One-time, locally-deployed stack: lets GitHub Actions deploy the app
 * stack without long-lived AWS keys. The role can only assume the CDK
 * bootstrap roles — but note the bootstrap cfn-exec role is admin, so
 * pushes to main effectively deploy with admin rights. The trust policy
 * is therefore pinned to exactly this repo and branch.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // AWS allows one provider per issuer URL per account. In the shared
    // management account my-infra's CI setup created the GitHub provider
    // (2026-06-12), so import it — my-infra owns its lifecycle (tearing that
    // repo's IaC down deletes the provider and breaks this role's trust).
    // A single-tenant sandbox account has no such owner, so stormdeck creates
    // its own: CREATE_OIDC_PROVIDER=1 keeps the provider in IaC (destroyed with
    // the account) and drops the cross-repo coupling. Default stays import so
    // the management account is untouched. See .claude/sandbox-migration/.
    const provider =
      process.env.CREATE_OIDC_PROVIDER === '1'
        ? new iam.OpenIdConnectProvider(this, 'GithubProvider', {
            url: 'https://token.actions.githubusercontent.com',
            clientIds: ['sts.amazonaws.com'],
          })
        : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            'GithubProvider',
            `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
          );

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'stormdeck-github-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/main`,
          },
        },
      ),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    // deploy-web syncs the built app straight to the bucket's site/
    // prefix and invalidates the distribution — no CDK roles involved.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncSitePrefix',
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [`arn:aws:s3:::stormdeck-${this.account}/site/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListBucketForSiteSync',
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::stormdeck-${this.account}`],
        conditions: { StringLike: { 's3:prefix': 'site/*' } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateSite',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/*`,
        ],
      }),
    );

    // The deploy workflow primes the weather feeds right after `cdk deploy`, so
    // a brand-new feed exists before the web that reads it publishes. The
    // function name is fixed (set in stormdeck-stack.ts); us-east-2 matches the
    // region every infra recipe pins.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PrimeWeatherFeeds',
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:us-east-2:${this.account}:function:stormdeck-weather-ingest`,
        ],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN repo variable',
    });
  }
}
