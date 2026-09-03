import { describe, expect, it, vi } from 'vitest';
import { crmAdapterOn, type CrmTransport } from '../src/composio.js';

function fakeTransport(replies: Record<string, unknown> = {}, proxyReply: unknown = {}) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const proxies: Array<{ method: string; endpoint: string; body?: unknown }> = [];
  const t: CrmTransport = {
    execute: vi.fn(async (slug, args) => { calls.push({ slug, args }); return (replies[slug] ?? {}) as Record<string, unknown>; }),
    proxy: vi.fn(async (method, endpoint, body) => { proxies.push({ method, endpoint, body }); return proxyReply; }),
  };
  return { t, calls, proxies };
}

const contact = { id: '42', properties: { firstname: 'Sam', lastname: null, phone: '+15555550100' } };

describe('composio CRM adapter', () => {
  it('searches by phone with the three phone filter groups and maps the first hit', async () => {
    const { t, calls } = fakeTransport({ HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: { results: [contact] } });
    const hit = await crmAdapterOn(t).findContactByPhone('+1 (555) 555-0100');
    expect(hit).toEqual({ id: '42', firstName: 'Sam', lastName: undefined, phone: '+15555550100' });
    const args = calls[0]!.args as { filterGroups: Array<{ filters: Array<{ propertyName: string; value: string }> }>; limit: number };
    expect(args.filterGroups.map((g) => g.filters[0]!.propertyName)).toEqual(['phone', 'mobilephone', 'hs_searchable_calculated_phone_number']);
    expect(args.filterGroups[2]!.filters[0]!.value).toBe('15555550100');
    expect(args.limit).toBe(1);
  });

  it('unwraps Composio response_data envelopes', async () => {
    const { t } = fakeTransport({ HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: { response_data: { results: [contact] } } });
    expect((await crmAdapterOn(t).findContactByPhone('+15555550100'))?.id).toBe('42');
  });

  it('patches only missing names on an existing contact, creates otherwise', async () => {
    const existing = fakeTransport({ HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: { results: [contact] } });
    const got = await crmAdapterOn(existing.t).upsertContact({ phone: '+15555550100', firstName: 'Samuel', lastName: 'Jones' });
    expect(got).toEqual({ id: '42', firstName: 'Sam', lastName: 'Jones', phone: '+15555550100' });
    expect(existing.calls.find((c) => c.slug === 'HUBSPOT_UPDATE_CONTACT')?.args).toEqual({ contactId: '42', properties: { lastname: 'Jones' } });

    const fresh = fakeTransport({ HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: { results: [] }, HUBSPOT_CREATE_CONTACT: { id: '99' } });
    const created = await crmAdapterOn(fresh.t).upsertContact({ phone: '+15555550101', firstName: 'New' });
    expect(created).toEqual({ id: '99', phone: '+15555550101', firstName: 'New', lastName: undefined });
    expect(fresh.calls.find((c) => c.slug === 'HUBSPOT_CREATE_CONTACT')?.args).toEqual({ phone: '+15555550101', firstname: 'New' });
  });

  it('creates notes and tasks associated to the contact with HubSpot type ids, html-escaped', async () => {
    const { t, calls } = fakeTransport({ HUBSPOT_RETRIEVE_OWNERS: { results: [{ id: 'own-1' }] } });
    const crm = crmAdapterOn(t);
    await crm.addNote('42', 'a < b\nline 2', new Date('2026-01-02T03:04:05Z'));
    await crm.addTask('42', { subject: 'Call back', body: 'x & y', dueAt: new Date('2026-01-05T17:00:00Z') });
    const note = calls.find((c) => c.slug === 'HUBSPOT_CREATE_NOTE')!.args as Record<string, unknown>;
    expect(note.hs_note_body).toBe('a &lt; b<br>line 2');
    expect(note.hs_timestamp).toBe('2026-01-02T03:04:05.000Z');
    expect(note.associations).toEqual([{ to: { id: '42' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]);
    const task = calls.find((c) => c.slug === 'HUBSPOT_CREATE_TASK')!.args as Record<string, unknown>;
    expect(task).toMatchObject({ hs_task_subject: 'Call back', hs_task_body: 'x &amp; y', hs_task_status: 'NOT_STARTED', hubspot_owner_id: 'own-1' });
    expect((task.associations as Array<{ types: Array<{ associationTypeId: number }> }>)[0]!.types[0]!.associationTypeId).toBe(204);
  });

  it('reads the last note through the raw HubSpot notes search and strips html', async () => {
    const { t, proxies } = fakeTransport({}, { results: [{ properties: { hs_note_body: '<p>Called <b>back</b></p>', hs_timestamp: '2026-01-01T00:00:00Z' } }] });
    const note = await crmAdapterOn(t).lastNote('42');
    expect(note).toEqual({ body: 'Called back', at: '2026-01-01T00:00:00Z' });
    expect(proxies[0]).toMatchObject({ method: 'POST', endpoint: '/crm/v3/objects/notes/search' });
    expect((proxies[0]!.body as { filterGroups: Array<{ filters: Array<{ value: string }> }> }).filterGroups[0]!.filters[0]!.value).toBe('42');
  });
});
