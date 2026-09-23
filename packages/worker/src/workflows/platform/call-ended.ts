/**
 * call.ended -> the transcript into the caller's memory, the minutes to
 * usage. Every tenant gets it identically: the worker stack's own rule, not
 * a tenant file's. A once-marker, since a redelivered event would otherwise
 * double both.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { CallEnded } from '@wnk/shared/contracts';
import type { AutomationOutcome } from '../automations/common.js';

const rows = proxyActivities<typeof activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });

export async function callEnded(event: CallEnded): Promise<AutomationOutcome> {
  if (event.status !== 'completed' || !(event.durationSeconds > 0)) return 'skipped';
  const key = 'done:call.ended';
  const call = await rows.readCall(event.callId, key, true);
  if (call.done) return 'skipped';
  await rows.recordMeter(event.tenantId, 'voice_minutes', event.durationSeconds / 60, event.callId);
  const lines = call.transcript.filter((t): t is typeof t & { role: 'user' | 'assistant' } => t.role !== 'tool').map((t) => ({ role: t.role, text: t.text }));
  if (event.callerPhone && lines.length > 0) await rows.rememberCall(`${event.tenantId}_${event.callerPhone.replace(/[^0-9]/g, '')}`, event.callId, lines);
  await rows.markDone(event.callId, key);
  return 'done';
}
