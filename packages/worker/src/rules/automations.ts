/**
 * The tenant automations' rules, as pure functions the workflows apply: what
 * a row's flags mean, the next business morning, the email body, the
 * toolkits the connection canary expects. The registry (which workflow runs
 * on which event) and the event shapes are contracts, in @wnk/shared.
 */
import type { LeadRecorded, TenantRow } from '@wnk/shared/contracts';

/** The tenant has a CRM the platform may act in: HubSpot, consented through Composio. */
export const hasCrm = (t: TenantRow) => t.crm?.type === 'hubspot' && t.crm.via === 'composio';

/** HubSpot note bodies are HTML. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * ISO timestamp of the next weekday at 9:00 tenant-local. `offsetMinutes` is
 * the seed's sessionDayOffsetMinutes (= 180 - zoneOffsetMinutes; 600 = Pacific).
 * No tz database here, so after a DST change the hour drifts by one until the next seed.
 */
export function nextBusinessMorning(offsetMinutes: number, nowMs: number): string {
  const zone = (180 - offsetMinutes) * 60_000;
  const day = Math.floor((nowMs + zone) / 86_400_000);
  for (let i = 0; i <= 7; i++) {
    const d = day + i;
    const dow = (d + 4) % 7;
    if (dow === 0 || dow === 6) continue;
    const t = d * 86_400_000 + 9 * 3_600_000 - zone;
    if (t > nowMs) return new Date(t).toISOString();
  }
  throw new Error('no business morning within a week');
}

/** The first and last name from what the caller gave. */
export function splitName(callerName: string): { name: string; first: string; last: string } {
  const name = callerName.trim();
  const i = name.indexOf(' ');
  return { name, first: i < 0 ? name : name.slice(0, i), last: i < 0 ? '' : name.slice(i + 1).trim() };
}

/** A HubSpot property that may be missing or null. */
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export interface Contact { id: string; url?: string; properties?: Record<string, unknown> }
export interface Note { hs_note_body?: string; hs_createdate?: string }

/** The owner's email, from existing data only. Preference records arrive as JSON text; show their sentence, not the blob. */
export function leadEmailBody(tenant: TenantRow, event: LeadRecorded, contact: Contact | undefined, note: Note | undefined, memories: string[]): string {
  const lead = event.lead;
  const noteText = (note?.hs_note_body ?? '').replace(/<br[^>]*>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').slice(0, 800);
  const crm = contact
    ? `known contact ${`${text(contact.properties?.firstname)} ${text(contact.properties?.lastname)}`.trim()} ${contact.url ?? ''}`
      + (note?.hs_note_body ? `\nLast note (${(note.hs_createdate ?? '').slice(0, 10)}):\n${noteText}` : '\nNo notes on this contact yet.')
    : 'no matching contact.';
  const prefs = memories.map((m) => `- ${m.startsWith('{') ? (/"preference":"([^"]*)"/.exec(m)?.[1] ?? m) : m}`);
  return [
    'New lead from the phone receptionist.\n\n',
    `Name: ${lead.callerName}\n`,
    `Phone: ${lead.phone ?? 'not provided'}\n`,
    `Reason: ${lead.reason}\n`,
    lead.preferredCallbackTime ? `Preferred callback: ${lead.preferredCallbackTime}\n` : '',
    lead.notes ? `Notes: ${lead.notes}\n` : '',
    `\nCRM: ${crm}\n`,
    prefs.length > 0 ? `\nCaller preferences (from earlier calls):\n${prefs.join('\n')}\n` : '',
    `\nSuggested text: Hi ${lead.callerName.split(' ')[0]}, this is ${tenant.business.name}. Thanks for calling about ${lead.reason}. When is a good time to talk? Reply here or call ${tenant.phoneNumber}.\n`,
    `\nCall ${event.callId}`,
  ].join('');
}

// ---- The connection canary's rules ----------------------------------------------
/** Toolkit slugs a tenant row must have ACTIVE in Composio, read from its own flags. A new toolkit is one more line. */
export function expectedToolkits(t: TenantRow): string[] {
  return [...(hasCrm(t) ? ['hubspot'] : []), ...(t.emailResponder?.enabled === true ? ['gmail'] : []), ...(t.facebookPosts?.enabled === true ? ['facebook'] : [])];
}
/** Of `expected`, those Composio does not report ACTIVE. */
export const missingToolkits = (expected: string[], active: string[]) => expected.filter((t) => !active.includes(t));
