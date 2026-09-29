/**
 * This deployment of the platform: its names and region (deployment.json),
 * its settings (cdk.json context), its tenants (tenants/). The stacks and
 * their wiring are ../platform.ts.
 */
import * as cdk from 'aws-cdk-lib';
import { PREFIX, REGION } from '../deployment.js';
import { definePlatform } from '../platform.js';
import { tenants } from '../../../tenants/index.js';

const app = new cdk.App();
definePlatform(app, {
  prefix: PREFIX,
  env: { region: REGION },
  tenants,
  browserbaseProjectId: app.node.tryGetContext('browserbaseProjectId') as string,
});
