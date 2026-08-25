import { describe, expect, it, vi } from 'vitest';
import { hubspotAdapter, nextBusinessMorning } from '../src/hubspot.js';

type Call = { method: string; path: string; body?: any };

function fakeHubspot(routes: Record<string, (body: any) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.hubapi.com', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('hubspotAdapter', () => {
  it('finds a contact by phone using three filter groups', async () => {
    const { fetchImpl, calls } = fakeHubspot({
      'POST /crm/v3/objects/contacts/search': () => ({ results: [{ id: '42', properties: { firstname: 'Jordan', lastname: null, phone: '+15555550155' } }] }),
    });
    const crm = hubspotAdapter('pat-test', fetchImpl);
    const c = await crm.findContactByPhone('+15555550155');
    expect(c).toEqual({ id: '42', firstName: 'Jordan', lastName: undefined, phone: '+15555550155' });
    const groups = calls[0]!.body.filterGroups.map((g: any) => g.filters[0]);
    expect(groups).toEqual([
      { propertyName: 'phone', operator: 'EQ', value: '+15555550155' },
      { propertyName: 'mobilephone', operator: 'EQ', value: '+15555550155' },
      { propertyName: 'hs_searchable_calculated_phone_number', operator: 'EQ', value: '15555550155' },
    ]);
    expect((fetchImpl as any).mock.calls[0][1].headers.Authorization).toBe('Bearer pat-test');
  });

  it('creates a contact when none exists, and patches missing names when one does', async () => {
    let exists = false;
    const { fetchImpl, calls } = fakeHubspot({
      'POST /crm/v3/objects/contacts/search': () => ({ results: exists ? [{ id: '7', properties: { firstname: null, lastname: null, phone: '+15550001111' } }] : [] }),
      'POST /crm/v3/objects/contacts': (b) => ({ id: '7', properties: b.properties }),
      'PATCH /crm/v3/objects/contacts/7': (b) => ({ id: '7', properties: b.properties }),
    });
    const crm = hubspotAdapter('t', fetchImpl);
    const created = await crm.upsertContact({ phone: '+15550001111', firstName: 'Sam' });
    expect(created.id).toBe('7');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts')!.body.properties).toEqual({ phone: '+15550001111', firstname: 'Sam' });
    exists = true;
    const updated = await crm.upsertContact({ phone: '+15550001111', firstName: 'Sam', lastName: 'Lee' });
    expect(updated.firstName).toBe('Sam');
    expect(calls.find((c) => c.method === 'PATCH')!.body.properties).toEqual({ firstname: 'Sam', lastname: 'Lee' });
  });

  it('creates notes and tasks associated to the contact with the right type ids', async () => {
    const { fetchImpl, calls } = fakeHubspot({
      'GET /crm/v3/owners?limit=1': () => ({ results: [{ id: 'owner-1' }] }),
      'POST /crm/v3/objects/notes': () => ({ id: 'n1' }),
      'POST /crm/v3/objects/tasks': () => ({ id: 't1' }),
    });
    const crm = hubspotAdapter('t', fetchImpl);
    await crm.addNote('42', 'line one\nline <two>');
    await crm.addTask('42', { subject: 'Follow up', body: 'call back', dueAt: new Date('2026-08-24T16:00:00Z') });
    const note = calls.find((c) => c.path === '/crm/v3/objects/notes')!.body;
    expect(note.properties.hs_note_body).toBe('line one<br>line &lt;two&gt;');
    expect(note.associations[0].types[0].associationTypeId).toBe(202);
    const task = calls.find((c) => c.path === '/crm/v3/objects/tasks')!.body;
    expect(task.properties).toMatchObject({ hs_task_subject: 'Follow up', hs_task_status: 'NOT_STARTED', hubspot_owner_id: 'owner-1', hs_timestamp: '2026-08-24T16:00:00.000Z' });
    expect(task.associations[0].types[0].associationTypeId).toBe(204);
  });

  it('throws a readable error on non-2xx', async () => {
    const crm = hubspotAdapter('t', (async () => new Response('bad token', { status: 401 })) as unknown as typeof fetch);
    await expect(crm.findContactByPhone('+15550001111')).rejects.toThrow(/401.*bad token/);
  });

  it('strips html from the last note', async () => {
    const { fetchImpl } = fakeHubspot({
      'POST /crm/v3/objects/notes/search': () => ({ results: [{ properties: { hs_note_body: '<p>Door <b>replacement</b></p>', hs_timestamp: '2026-08-21T23:53:00Z' } }] }),
    });
    const n = await hubspotAdapter('t', fetchImpl).lastNote('42');
    expect(n).toEqual({ body: 'Door replacement', at: '2026-08-21T23:53:00Z' });
  });
});

describe('nextBusinessMorning', () => {
  const LA = 'America/Los_Angeles';
  it('returns today 9am if called early on a weekday', () => {
    // Fri 2026-08-21 06:00 PDT = 13:00Z
    const d = nextBusinessMorning(new Date('2026-08-21T13:00:00Z'), LA);
    expect(d.toISOString()).toBe('2026-08-21T16:00:00.000Z');
  });
  it('skips the weekend', () => {
    // Fri 2026-08-21 16:53 PDT = 23:53Z -> Mon 24th 9am PDT = 16:00Z
    const d = nextBusinessMorning(new Date('2026-08-21T23:53:00Z'), LA);
    expect(d.toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });
});
