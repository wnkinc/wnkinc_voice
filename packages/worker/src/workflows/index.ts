/**
 * Workflows: deterministic code Temporal replays from history. No I/O, no
 * clocks, no randomness here; those go through activities. Every export is a
 * workflow type a client can start.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const { echo } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

/** Temporal Cloud invokes the Lambda, the Worker runs a workflow task and an activity, the result comes back. */
export async function ping(name: string): Promise<string> {
  return echo(name);
}
