/**
 * Activities: the side effects. Everything that touches a table, a secret, a
 * SaaS, or a model lives here; workflow code stays deterministic and only
 * decides. Each activity that acts for a tenant takes the tenant id as an
 * argument; none reads it from anywhere else.
 */
export { lookupPerson, lookupTenant } from './identity.js';
export { cancelDraft, createDraft, findPending, lockDraft, markCompleted, markFailed, markShown, markUnconfirmed, recentMedia, rememberMedia, reviseDraft } from './ledger.js';
export { sendText } from './twilio.js';
export { mintLinks } from './media.js';
export { callModel } from './model.js';
export { composioAccounts, composioProxy, composioToolDefs, executeTool } from './composio.js';
export { loadHistory, recall, recallPreferences, rememberCall, saveTurn } from './memory.js';
export { recordMeter, recordUsage } from './usage.js';
export { markDone, readCall } from './calls.js';
export { sendTelegram } from './telegram.js';
export { browserLiveView, createBrowserContext, releaseBrowserSession, startBrowserSession } from './browser.js';
export { claimLoginWindow, clearLoginWindow, listTenants, saveBrowserContext } from './tenants.js';

/** Proves the pipe end to end without touching anything. */
export async function echo(name: string): Promise<string> {
  return `pong: ${name}`;
}
