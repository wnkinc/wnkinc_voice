/**
 * The CRM contract the platform programs against. One adapter per CRM
 * product; today HubSpot, reached through Composio (composio.ts) — the
 * credential is chosen per call by tenant id, never held by our code.
 */

export interface CrmContact {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
}

export interface CrmNote {
  body: string;
  at: string; // ISO
}

export interface CrmAdapter {
  /** Free-text search over the CRM's default searchable contact fields (name, email, phone). */
  searchContacts(query: string, limit?: number): Promise<CrmContact[]>;
  getContact(contactId: string): Promise<CrmContact | undefined>;
  findContactByPhone(phone: string): Promise<CrmContact | undefined>;
  lastNote(contactId: string): Promise<CrmNote | undefined>;
  upsertContact(input: { phone: string; firstName?: string; lastName?: string }): Promise<CrmContact>;
  addNote(contactId: string, body: string, at?: Date): Promise<void>;
  addTask(contactId: string, task: { subject: string; body: string; dueAt: Date }): Promise<void>;
}

/** HubSpot association type ids (HUBSPOT_DEFINED). */
export const HUBSPOT_NOTE_TO_CONTACT = 202;
export const HUBSPOT_TASK_TO_CONTACT = 204;

export function textToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Next weekday at `hour`:00 in the tenant's timezone (for follow-up task due dates). */
export function nextBusinessMorning(now: Date, timeZone: string, hour = 9): Date {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const off = tzOffsetMs(d, timeZone);
    const local = new Date(d.getTime() + off);
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour) - off);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + 86_400_000);
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - date.getTime();
}
