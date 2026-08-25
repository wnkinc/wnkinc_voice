import * as cdk from 'aws-cdk-lib';
import { VoiceStack } from '../lib/voice-stack.js';

const app = new cdk.App();

new VoiceStack(app, 'wnk-voice-dev', {
  prefix: 'wnkinc-voice-dev',
  env: { region: 'us-west-2' },
  sesFromEmail: process.env.SES_FROM_EMAIL ?? '',
});
