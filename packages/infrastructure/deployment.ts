/**
 * Which deployment this is: deployment.json in the directory the command runs
 * from (or the file DEPLOYMENT_FILE names). The CDK app and the scripts read
 * their names and region from here; the stacks and their tests take a prefix
 * and never read it. A missing or malformed file fails before anything is named.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prefixOf, stacksOf, workerNames, type Deployment } from './names.js';

export function readDeployment(file: string): Deployment {
  const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<Deployment>;
  // The two words end up in stack, function and secret names: lowercase letters and digits only.
  for (const key of ['project', 'stage'] as const) if (!/^[a-z][a-z0-9]*$/.test(d[key] ?? '')) throw new Error(`${file}: "${key}" must be lowercase letters and digits`);
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(d.region ?? '')) throw new Error(`${file}: "region" must be an AWS region`);
  return { project: d.project!, stage: d.stage!, region: d.region! };
}

export const DEPLOYMENT = readDeployment(process.env.DEPLOYMENT_FILE ?? resolve(process.cwd(), 'deployment.json'));
export const REGION = DEPLOYMENT.region;
export const PREFIX = prefixOf(DEPLOYMENT);
export const STACKS = stacksOf(PREFIX);
export const WORKER = workerNames(PREFIX);
