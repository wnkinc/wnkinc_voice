import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.js';
import { GatewayStack } from '../lib/gateway-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = 'wnkinc-voice-dev';

new VoiceStack(app, 'wnk-voice-dev', { prefix, env, sesFromEmail: process.env.SES_FROM_EMAIL ?? '' });

const auth = new CognitoStack(app, 'wnk-auth-dev', { prefix, env });
const identity = new IdentityStack(app, 'wnk-identity-dev', {
  prefix,
  env,
  hubspotSecretName: `${prefix}/crm/wnk`,
});
new GatewayStack(app, 'wnk-gateway-dev', {
  prefix,
  env,
  userPool: auth.userPool,
  machineClient: auth.machineClient,
  hubspotProvider: identity.hubspotProvider,
});
