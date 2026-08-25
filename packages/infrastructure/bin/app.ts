import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.js';
import { GatewayStack } from '../lib/gateway-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import { PolicyStack } from '../lib/policy-stack.js';
import { RuntimeStack } from '../lib/runtime-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = 'wnkinc-voice-dev';

const auth = new CognitoStack(app, 'wnk-auth-dev', { prefix, env });

// The gateway's URL, from context: the gateway stack consumes the voice stack's
// tools Lambda, so the URL can't be a stack reference without a cycle. Set/update
// `wnk:gatewayUrl` in cdk.json after (re)creating the gateway.
const gatewayUrl = app.node.tryGetContext('wnk:gatewayUrl') as string | undefined;
const voice = new VoiceStack(app, 'wnk-voice-dev', {
  prefix,
  env,
  sesFromEmail: process.env.SES_FROM_EMAIL ?? '',
  gateway: gatewayUrl
    ? {
        gatewayUrl,
        userPoolId: auth.userPool.userPoolId,
        clientId: auth.voiceClient.userPoolClientId,
        tokenUrl: auth.tokenUrl,
      }
    : undefined,
});
const identity = new IdentityStack(app, 'wnk-identity-dev', {
  prefix,
  env,
  hubspotSecretName: `${prefix}/crm/wnk`,
  googleOauthSecretName: `${prefix}/oauth/google`,
});
const policy = new PolicyStack(app, 'wnk-policy-dev', {
  prefix,
  env,
  gatewayId: (app.node.tryGetContext('wnk:gatewayId') as string | undefined) ?? '',
  adminClientId: auth.machineClient.userPoolClientId,
  voiceClientId: auth.voiceClient.userPoolClientId,
  emailClientId: auth.emailClient.userPoolClientId,
});
const gateway = new GatewayStack(app, 'wnk-gateway-dev', {
  prefix,
  env,
  userPool: auth.userPool,
  allowedClients: [auth.machineClient, auth.voiceClient, auth.emailClient],
  hubspotProvider: identity.hubspotProvider,
  voiceToolsFn: voice.gatewayToolsFn,
  policyEngineArn: policy.engine.attrPolicyEngineArn,
});
new RuntimeStack(app, 'wnk-runtime-dev', {
  prefix,
  env,
  gatewayUrl: gateway.gateway.gatewayUrl ?? '',
  cognitoUserPoolId: auth.userPool.userPoolId,
  cognitoClientId: auth.emailClient.userPoolClientId,
  cognitoTokenUrl: auth.tokenUrl,
  workloadName: identity.emailResponderIdentity.workloadIdentityName,
  googleProviderName: `${prefix.replace(/-/g, '_')}_google`,
  openaiSecret: voice.openaiSecret,
  bus: voice.bus,
});
