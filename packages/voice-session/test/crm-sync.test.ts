import { describe, expect, it, vi } from 'vitest';
import { createCrmSyncHandler, splitName, type CrmSyncEvent } from '../src/crm-sync.js';
import type { CrmAdapter } from '../src/hubspot.js';
import { memoryStore } from '@wnk/shared';
import { silentLog, TENANT } from './helpers.js';

function fakeCrm(existing?: { id: string; firstName?: string }): CrmAdapter & { notes: string[]; tasks: string[] } {
  const notes: string[] = [];
  const tasks: string[] = [];
  return {
    notes, tasks,
    searchContacts: vi.fn(async () => (existing ? [existing] : [])),
    getContact: vi.fn(async () => existing),
    findContactByPhone: vi.fn(async () => existing),
    lastNote: vi.fn(async () => undefined),
    upsertContact: vi.fn(async (i) => existing ?? { id: 'new-1', firstName: i.firstName }),
    addNote: vi.fn(async (_id, body) => { notes.push(body); }),
    addTask: vi.fn(async (_id, t) => { tasks.push(t.subject); }),
  };
}

const base = { tenantId: 'acme', tenantPhoneNumber: '+15555550100', callId: 'call_1' };
const leadEvent = (phone?: string): CrmSyncEvent => ({
  'detail-type': 'lead.recorded',
  detail: { ...base, lead: { tenantId: 'acme', sk: 'x', leadId: 'L1', callId: 'call_1', createdAt: 'now', callerName: 'Jordan Rivera', phone, reason: 'door replacement', preferredCallbackTime: 'mornings' } },
} as CrmSyncEvent);
const endedEvent = (callerPhone?: string): CrmSyncEvent => ({
  'detail-type': 'call.ended',
  detail: { ...base, callerPhone, status: 'completed', durationSeconds: 107, transcript: [
    { role: 'assistant', text: 'Thanks for calling', at: 'x' }, { role: 'user', text: 'Hi', at: 'x' }, { role: 'tool', text: 'record_lead(...)', at: 'x' },
  ] },
} as CrmSyncEvent);

describe('crm-sync', () => {
  it('splits names', () => {
    expect(splitName('Jordan')).toEqual({ firstName: 'Jordan', lastName: undefined });
    expect(splitName('Jordan N Rivera')).toEqual({ firstName: 'Jordan', lastName: 'N Rivera' });
  });

  it('does nothing for tenants without a CRM', async () => {
    const crm = fakeCrm();
    const h = createCrmSyncHandler({ store: () => memoryStore([TENANT]), crmFor: async () => crm, log: silentLog });
    await h(leadEvent('+15550001111'));
    expect(crm.upsertContact).not.toHaveBeenCalled();
  });

  it('lead.recorded -> contact + note + task due next business morning', async () => {
    const crm = fakeCrm();
    const h = createCrmSyncHandler({
      store: () => memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]),
      crmFor: async () => crm, log: silentLog,
      now: () => new Date('2026-08-21T23:53:00Z'),
    });
    await h(leadEvent('+15550001111'));
    expect(crm.upsertContact).toHaveBeenCalledWith({ phone: '+15550001111', firstName: 'Jordan', lastName: 'Rivera' });
    expect(crm.notes[0]).toContain('door replacement');
    expect(crm.notes[0]).toContain('Call ID: call_1');
    expect(crm.tasks).toEqual(['Follow up with Jordan Rivera (+15550001111)']);
    const due = (crm.addTask as any).mock.calls[0][1].dueAt as Date;
    expect(due.toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });

  it('a redelivered lead.recorded creates one note and one task', async () => {
    const crm = fakeCrm();
    const store = memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]);
    const h = createCrmSyncHandler({ store: () => store, crmFor: async () => crm, log: silentLog });
    await h(leadEvent('+15550001111'));
    await h(leadEvent('+15550001111'));
    expect(crm.notes).toHaveLength(1);
    expect(crm.tasks).toHaveLength(1);
  });

  it('lead without a phone is skipped', async () => {
    const crm = fakeCrm();
    const h = createCrmSyncHandler({ store: () => memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]), crmFor: async () => crm, log: silentLog });
    await h(leadEvent(undefined));
    expect(crm.upsertContact).not.toHaveBeenCalled();
  });

  it('call.ended logs a transcript note on an existing contact only', async () => {
    const known = fakeCrm({ id: '42', firstName: 'Jordan' });
    const h = createCrmSyncHandler({ store: () => memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]), crmFor: async () => known, log: silentLog });
    await h(endedEvent('+15550001111'));
    expect(known.notes).toHaveLength(1);
    expect(known.notes[0]).toContain('Agent: Thanks for calling');
    expect(known.notes[0]).toContain('Caller: Hi');
    expect(known.notes[0]).not.toContain('record_lead');

    const unknown = fakeCrm(undefined);
    const h2 = createCrmSyncHandler({ store: () => memoryStore([{ ...TENANT, crm: { type: 'hubspot' } }]), crmFor: async () => unknown, log: silentLog });
    await h2(endedEvent('+15550002222'));
    expect(unknown.notes).toHaveLength(0);
  });
});
