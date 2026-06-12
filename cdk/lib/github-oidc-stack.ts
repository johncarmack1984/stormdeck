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

    // AWS allows one provider per issuer URL per account, and my-infra's
    // CI setup created the GitHub one on 2026-06-12 — so import it rather
    // than create a duplicate. my-infra owns its lifecycle: tearing that
    // repo's IaC down deletes the provider and breaks this role's trust.
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
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

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN repo variable',
    });
  }
}
