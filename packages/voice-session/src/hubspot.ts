/**
 * Minimal HubSpot CRM client (REST v3, service-key auth). Five calls, no SDK.
 * Hidden behind CrmAdapter so a second CRM is a second file.
 */

import { HUBSPOT_NOTE_TO_CONTACT, HUBSPOT_TASK_TO_CONTACT, htmlToText, textToHtml, type CrmAdapter, type CrmContact } from '@wnk/shared';
export { nextBusinessMorning, type CrmAdapter, type CrmContact, type CrmNote } from '@wnk/shared';


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
    async searchContacts(query, limit = 5) {
      const res = await api<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>('POST', '/crm/v3/objects/contacts/search', {
        query, limit, properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email'],
      });
      return res.results.map(toContact);
    },
    async getContact(contactId) {
      return api<{ id: string; properties: Record<string, string | null> }>('GET', `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,phone,mobilephone,email`)
        .then(toContact).catch(() => undefined);
    },
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
      return { body: htmlToText(n.hs_note_body), at: n.hs_timestamp ?? '' };
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
        properties: { hs_timestamp: at.toISOString(), hs_note_body: textToHtml(body) },
        associations: assoc(contactId, HUBSPOT_NOTE_TO_CONTACT),
      });
    },

    async addTask(contactId, task) {
      const owner = await defaultOwner();
      await api('POST', '/crm/v3/objects/tasks', {
        properties: {
          hs_timestamp: task.dueAt.toISOString(),
          hs_task_subject: task.subject,
          hs_task_body: textToHtml(task.body),
          hs_task_status: 'NOT_STARTED',
          hs_task_priority: 'MEDIUM',
          hs_task_type: 'TODO',
          ...(owner ? { hubspot_owner_id: owner } : {}),
        },
        associations: assoc(contactId, HUBSPOT_TASK_TO_CONTACT),
      });
    },
  };
}
