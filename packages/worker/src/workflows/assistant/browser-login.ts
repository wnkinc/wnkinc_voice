/**
 * Browser login handoff: /login on Telegram -> a Browserbase session on the
 * tenant's saved browser -> the live view link to the owner -> released
 * after the window, with whatever they signed into kept.
 *
 * No model. The tenant's saved browser is a Browserbase context whose id
 * lives on the tenant row as `browser.contextId`: created here on first use
 * and written to the row; the reply asks the owner to add it to the tenant
 * file so a re-seed keeps it. Nothing here touches the page: the owner
 * drives the live view. The window is a durable timer.
 */
import { ApplicationFailure, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const browser = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });
const replies = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });

export interface BrowserLoginInput {
  tenantId: string;
  tenantPhoneNumber: string;
  chatId: number | string;
  /** The command as sent: `/login <site>`. */
  text: string;
  /** How long the live view stays open for the owner. */
  windowSeconds?: number;
}
export type BrowserLoginOutcome = 'busy' | 'closed';

/** What the owner said they are logging into: the command text after '/login' ('' when nothing). */
export const loginSite = (text: string) => text.slice(6).trim();

export async function browserLogin(input: BrowserLoginInput): Promise<BrowserLoginOutcome> {
  const windowSeconds = input.windowSeconds ?? 600;
  const minutes = Math.round(windowSeconds / 60);
  const tenant = await rows.lookupTenant(input.tenantPhoneNumber);
  if (!tenant || tenant.browser?.enabled !== true) throw ApplicationFailure.nonRetryable('browser.enabled is not true on the tenant row', 'BrowserNotEnabled');
  const tell = (text: string) => replies.sendTelegram(input.chatId, text);

  if (!await rows.claimLoginWindow(tenant.phoneNumber, new Date(Date.now() + (windowSeconds + 300) * 1000).toISOString())) {
    await tell('A browser is already open for this business. Use the link you have, or try again once it closes.');
    return 'busy';
  }
  let contextId = tenant.browser.contextId;
  let created = false;
  if (!contextId) {
    contextId = await browser.createBrowserContext(tenant.tenantId);
    await rows.saveBrowserContext(tenant.phoneNumber, contextId);
    created = true;
  }
  const sessionId = await browser.startBrowserSession(contextId, windowSeconds + 300);
  const url = await browser.browserLiveView(sessionId);
  const site = loginSite(input.text);
  await tell(`Browser ready${site ? ` for ${site}` : ''}. Open the link, go to the site, and sign in. It closes in ${minutes} minutes; the login is kept for next time. ${url}`
    + (created ? `\n\nFirst browser for this business. Add browser.contextId = ${contextId} to the tenant file so a re-seed keeps it.` : ''));

  await sleep(windowSeconds * 1000);

  // A failed release still tells the owner; Browserbase's timeout ends the session either way.
  try { await browser.releaseBrowserSession(sessionId); } catch { /* the backstop timeout closes it */ }
  await rows.clearLoginWindow(tenant.phoneNumber);
  await tell('Browser closed. Whatever you signed into is saved for this business.');
  return 'closed';
}
