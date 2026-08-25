/**
 * Minimal HubSpot CRM client (REST v3, service-key auth). Five calls, no SDK.
 * Hidden behind CrmAdapter so a second CRM is a second file.
 */

export interface CrmContact {
  id: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface CrmNote {
  body: string;
  at: string; // ISO
}

export interface CrmAdapter {
  findContactByPhone(phone: string): Promise<CrmContact | undefined>;
  lastNote(contactId: string): Promise<CrmNote | undefined>;
  upsertContact(input: { phone: string; firstName?: string; lastName?: string }): Promise<CrmContact>;
  addNote(contactId: string, body: string, at?: Date): Promise<void>;
  addTask(contactId: string, task: { subject: string; body: string; dueAt: Date }): Promise<void>;
}

const NOTE_TO_CONTACT = 202;
const TASK_TO_CONTACT = 204;

export function hubspotAdapter(token: string, fetchImpl: typeof fetch = fetch, baseUrl = 'https://api.hubapi.com'): CrmAdapter {
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HubSpot ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const assoc = (contactId: string, typeId: number) => [
    { to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] },
  ];
  const toContact = (r: { id: string; properties: Record<string, string | null> }): CrmContact => ({
    id: r.id,
    firstName: r.properties.firstname ?? undefined,
    lastName: r.properties.lastname ?? undefined,
    phone: r.properties.phone ?? r.properties.mobilephone ?? undefined,
  });

  let ownerId: Promise<string | undefined> | undefined;
  const defaultOwner = () =>
    (ownerId ??= api<{ results: Array<{ id: string }> }>('GET', '/crm/v3/owners?limit=1')
      .then((r) => r.results[0]?.id)
      .catch(() => undefined));

  return {
    async findContactByPhone(phone) {
      const digits = phone.replace(/\D/g, '');
      const eq = (propertyName: string, value: string) => ({ filters: [{ propertyName, operator: 'EQ', value }] });
      const res = await api<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [eq('phone', phone), eq('mobilephone', phone), eq('hs_searchable_calculated_phone_number', digits)],
        properties: ['firstname', 'lastname', 'phone', 'mobilephone'],
        limit: 1,
      });
      return res.results[0] ? toContact(res.results[0]) : undefined;
    },

    async lastNote(contactId) {
      const res = await api<{ results: Array<{ properties: { hs_note_body: string | null; hs_timestamp: string | null } }> }>('POST', '/crm/v3/objects/notes/search', {
        filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contactId }] }],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        properties: ['hs_note_body', 'hs_timestamp'],
        limit: 1,
      });
      const n = res.results[0]?.properties;
      if (!n?.hs_note_body) return undefined;
      return { body: n.hs_note_body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), at: n.hs_timestamp ?? '' };
    },

    async upsertContact(input) {
      const existing = await this.findContactByPhone(input.phone);
      const props: Record<string, string> = {};
      if (input.firstName && !existing?.firstName) props.firstname = input.firstName;
      if (input.lastName && !existing?.lastName) props.lastname = input.lastName;
      if (existing) {
        if (Object.keys(props).length) await api('PATCH', `/crm/v3/objects/contacts/${existing.id}`, { properties: props });
        return { ...existing, firstName: existing.firstName ?? input.firstName, lastName: existing.lastName ?? input.lastName };
      }
      const created = await api<{ id: string; properties: Record<string, string | null> }>('POST', '/crm/v3/objects/contacts', {
        properties: { phone: input.phone, ...props },
      });
      return toContact(created);
    },

    async addNote(contactId, body, at = new Date()) {
      await api('POST', '/crm/v3/objects/notes', {
        properties: { hs_timestamp: at.toISOString(), hs_note_body: toHtml(body) },
        associations: assoc(contactId, NOTE_TO_CONTACT),
      });
    },

    async addTask(contactId, task) {
      const owner = await defaultOwner();
      await api('POST', '/crm/v3/objects/tasks', {
        properties: {
          hs_timestamp: task.dueAt.toISOString(),
          hs_task_subject: task.subject,
          hs_task_body: toHtml(task.body),
          hs_task_status: 'NOT_STARTED',
          hs_task_priority: 'MEDIUM',
          hs_task_type: 'TODO',
          ...(owner ? { hubspot_owner_id: owner } : {}),
        },
        associations: assoc(contactId, TASK_TO_CONTACT),
      });
    },
  };
}

function toHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
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
