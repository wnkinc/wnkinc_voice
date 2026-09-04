import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.js';
import { ConsoleStack } from '../lib/console-stack.js';
import { IdentityStack } from '../lib/identity-stack.js';
import { MemoryStack } from '../lib/memory-stack.js';
import { RuntimeStack } from '../lib/runtime-stack.js';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = 'wnkinc-voice-dev';

const auth = new CognitoStack(app, 'wnk-auth-dev', { prefix, env });
const memory = new MemoryStack(app, 'wnk-memory-dev', { prefix, env });
const callerMemory = { memoryId: memory.memory.memoryId, memoryArn: memory.memory.memoryArn };

const voice = new VoiceStack(app, 'wnk-voice-dev', {
  prefix,
  env,
  sesFromEmail: process.env.SES_FROM_EMAIL ?? '',
  alarmEmail: process.env.ALARM_EMAIL,
  callerMemory,
});
const identity = new IdentityStack(app, 'wnk-identity-dev', {
  prefix,
  env,
  openaiSecret: voice.openaiSecret,
  composioSecret: voice.composioSecret,
});
new RuntimeStack(app, 'wnk-runtime-dev', {
  prefix,
  env,
  openaiSecret: voice.openaiSecret,
  composioSecret: voice.composioSecret,
  openaiProviderArn: identity.openaiProvider.credentialProviderArn,
  composioProviderArn: identity.composioProvider.credentialProviderArn,
  bus: voice.bus,
  usageTable: voice.usageTable,
  tenantsTable: voice.tenantsTable,
  callsTable: voice.callsTable,
  peopleTable: voice.peopleTable,
  api: voice.api,
  alarmTopic: voice.alarmTopic,
  callerMemory,
});

new ConsoleStack(app, 'wnk-console-dev', {
  prefix,
  env,
  userPool: auth.userPool,
  authBaseUrl: auth.authBaseUrl,
  tenantsTable: voice.tenantsTable,
  callsTable: voice.callsTable,
  usageTable: voice.usageTable,
  callerMemory,
});
