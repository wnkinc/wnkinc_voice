import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.js';
import { GatewayStack } from '../lib/gateway-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import { RuntimeStack } from '../lib/runtime-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = 'wnkinc-voice-dev';

const voice = new VoiceStack(app, 'wnk-voice-dev', { prefix, env, sesFromEmail: process.env.SES_FROM_EMAIL ?? '' });

const auth = new CognitoStack(app, 'wnk-auth-dev', { prefix, env });
const identity = new IdentityStack(app, 'wnk-identity-dev', {
  prefix,
  env,
  hubspotSecretName: `${prefix}/crm/wnk`,
  googleOauthSecretName: `${prefix}/oauth/google`,
});
const gateway = new GatewayStack(app, 'wnk-gateway-dev', {
  prefix,
  env,
  userPool: auth.userPool,
  machineClient: auth.machineClient,
  hubspotProvider: identity.hubspotProvider,
});
new RuntimeStack(app, 'wnk-runtime-dev', {
  prefix,
  env,
  gatewayUrl: gateway.gateway.gatewayUrl ?? '',
  cognitoUserPoolId: auth.userPool.userPoolId,
  cognitoClientId: auth.machineClient.userPoolClientId,
  cognitoTokenUrl: auth.tokenUrl,
  workloadName: identity.emailResponderIdentity.workloadIdentityName,
  googleProviderName: `${prefix.replace(/-/g, '_')}_google`,
  openaiSecret: voice.openaiSecret,
  bus: voice.bus,
});
