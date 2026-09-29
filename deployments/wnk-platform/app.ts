/**
 * This deployment of the platform: its names and region (deployment.json),
 * its settings (cdk.json context), its tenants (tenants/). The stacks and
 * their wiring are core's (packages/infrastructure/platform.ts). Commands run
 * from this directory.
 */
import * as cdk from 'aws-cdk-lib';
import { PREFIX, REGION } from '../../packages/infrastructure/deployment.js';
import { definePlatform } from '../../packages/infrastructure/platform.js';
import { tenants } from './tenants/index.js';

const app = new cdk.App();
definePlatform(app, {
  prefix: PREFIX,
  env: { region: REGION },
  tenants,
  browserbaseProjectId: app.node.tryGetContext('browserbaseProjectId') as string,
});
