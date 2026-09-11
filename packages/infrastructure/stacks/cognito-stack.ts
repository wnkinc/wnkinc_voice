import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface CognitoStackProps extends cdk.StackProps {
  readonly prefix: string;
}

/**
 * Inbound identity for people: employees get user accounts with a
 * `businessId` custom attribute that rides into their ID token, and the
 * console keys every read on it. Agents hold no Cognito identity — the
 * tenant is selected before any model runs (signed webhook called-number,
 * People-table lookup, bus event) and Composio scopes SaaS by tenant id.
 */
export class CognitoStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  /** Hosted-UI base URL for OAuth flows (the console's login). */
  readonly authBaseUrl: string;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    this.userPool = new cognito.UserPool(this, 'Employees', {
      userPoolName: `${prefix}-employees`,
      selfSignUpEnabled: false, // only admins create users
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        // Rides into JWTs as custom:businessId; every downstream layer keys on it.
        businessId: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // learning stack
    });

    // Hosted domain: the console's login page.
    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${prefix}-${this.account}` },
    });

    this.authBaseUrl = domain.baseUrl();
    new cdk.CfnOutput(this, 'userPoolId', { value: this.userPool.userPoolId });
  }
}
