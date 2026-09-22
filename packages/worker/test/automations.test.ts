/** The tenant automations through a real Worker with recorded fakes: the flag first, the once-marker, the side effects in order, the mark after. */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallEnded, LeadRecorded, OwnerNotify } from '../src/automations/catalog.js';
import { callEnded, crmCall, crmLead, leadEmail, ownerAlert } from '../src/workflows/index.js';
import { failure, fakes, run as runWorkflow, tenant, type Fakes } from './fakes.js';

const crmTenant = { ...tenant, crm: { type: 'hubspot', via: 'composio' }, emailResponder: { enabled: true }, people: [{ name: 'Meg', role: 'owner' as const, telegramId: 777 }] };
const lead: LeadRecorded = { tenantId: 'deck', tenantPhoneNumber: '+15550001111', callId: 'call-1', lead: { leadId: 'lead-1', callId: 'call-1', callerName: 'Jordan Rivera', phone: '+15555550155', reason: 'a warped door', preferredCallbackTime: 'mornings' } };
const ended: CallEnded = { tenantId: 'deck', tenantPhoneNumber: '+15550001111', callId: 'call-1', callerPhone: '+15555550155', status: 'completed', durationSeconds: 130 };
const notify: OwnerNotify = { tenantId: 'deck', tenantPhoneNumber: '+15550001111', callId: 'call-1', summary: 'Flooding at 12 Elm.', urgency: 'urgent', callerPhone: '+15555550155' };

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });
const slugs = (f: Fakes) => f.executeTool.mock.calls.map((c) => c[1]);
const withCrm = () => { const f = fakes(); f.lookupTenant.mockResolvedValue(crmTenant); f.readCall.mockResolvedValue({ done: false, transcript: [] }); return f; };

describe('lead email', () => {
  it('enriches from the CRM and memory, sends from the owner\'s Gmail to the owner, marks, meters', async () => {
    const f = withCrm();
    f.executeTool
      .mockResolvedValueOnce({ successful: true, data: { results: [{ id: '9', url: 'https://hs/9', properties: { firstname: 'Jordan', lastname: 'Rivera' } }] } })
      .mockResolvedValueOnce({ successful: true, data: { emailAddress: 'owner@deck.co' } })
      .mockResolvedValueOnce({ successful: true, data: {} });
    f.composioAccounts.mockResolvedValue([{ id: 'acct', toolkit: 'hubspot' }]);
    f.composioProxy.mockResolvedValue({ successful: true, data: { results: [{ properties: { hs_note_body: 'Called <b>before</b>&nbsp;about a deck', hs_createdate: '2026-09-01T10:00:00Z' } }] } });
    f.recallPreferences.mockResolvedValue(['{"preference":"text, not calls"}']);
    expect(await runWorkflow(env, f, leadEmail, [lead])).toBe('done');
    expect(slugs(f)).toEqual(['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'GMAIL_GET_PROFILE', 'GMAIL_SEND_EMAIL']);
    expect(f.recallPreferences).toHaveBeenCalledWith('deck_15555550155');
    const sendArgs = f.executeTool.mock.calls[2]?.[2] as { recipient_email: string; subject: string; body: string };
    expect(sendArgs.recipient_email).toBe('owner@deck.co');
    expect(sendArgs.subject).toBe('New lead: Jordan Rivera - a warped door');
    expect(sendArgs.body).toContain('CRM: known contact Jordan Rivera https://hs/9\nLast note (2026-09-01):\nCalled before about a deck');
    expect(sendArgs.body).toContain('- text, not calls');
    expect(sendArgs.body).toContain('Suggested text: Hi Jordan, this is Deck Co.');
    expect(f.markDone).toHaveBeenCalledWith('call-1', 'done:email:lead:lead-1', true);
    expect(f.recordMeter).toHaveBeenCalledWith('deck', 'emails_sent', 1, 'call-1');
  }, 60_000);

  it('skips a tenant without the responder, and a lead already emailed', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...crmTenant, emailResponder: { enabled: false } });
    expect(await runWorkflow(env, f, leadEmail, [lead])).toBe('skipped');
    const g = withCrm();
    g.readCall.mockResolvedValue({ done: true, transcript: [] });
    expect(await runWorkflow(env, g, leadEmail, [lead])).toBe('skipped');
    expect(g.executeTool).not.toHaveBeenCalled();
  }, 60_000);

  it('enrichment failing costs only the detail; no Gmail fails the workflow before any send', async () => {
    const f = withCrm();
    f.executeTool.mockRejectedValueOnce(new Error('hubspot down')).mockResolvedValueOnce({ successful: true, data: {} });
    const failed = await failure(runWorkflow(env, f, leadEmail, [lead]));
    expect(failed.type).toBe('NoGmailConnection');
    expect(slugs(f)).toEqual(['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'GMAIL_GET_PROFILE']);
    expect(f.markDone).not.toHaveBeenCalled();
  }, 60_000);

  it('a send Composio rejects is one attempt, fails the workflow, and marks nothing', async () => {
    const f = withCrm();
    f.lookupTenant.mockResolvedValue({ ...crmTenant, crm: undefined });
    f.executeTool.mockResolvedValueOnce({ successful: true, data: { emailAddress: 'owner@deck.co' } }).mockResolvedValue({ successful: false, error: 'quota' });
    expect((await failure(runWorkflow(env, f, leadEmail, [lead]))).type).toBe('SendRejected');
    expect(slugs(f).filter((s) => s === 'GMAIL_SEND_EMAIL')).toHaveLength(1);
    expect(f.markDone).not.toHaveBeenCalled();
  }, 60_000);
});

describe('crm lead', () => {
  it('creates a new contact, adds the note, and a task for the next business morning with the first owner', async () => {
    const f = withCrm();
    f.executeTool
      .mockResolvedValueOnce({ successful: true, data: { results: [] } })
      .mockResolvedValueOnce({ successful: true, data: { id: '77' } })
      .mockResolvedValueOnce({ successful: true, data: { id: 'n1' } })
      .mockResolvedValueOnce({ successful: true, data: { results: [{ id: 'owner-1' }] } })
      .mockResolvedValueOnce({ successful: true, data: { id: 't1' } });
    expect(await runWorkflow(env, f, crmLead, [lead])).toBe('done');
    expect(slugs(f)).toEqual(['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_CREATE_CONTACT', 'HUBSPOT_CREATE_NOTE', 'HUBSPOT_RETRIEVE_OWNERS', 'HUBSPOT_CREATE_TASK']);
    expect(f.executeTool.mock.calls[1]?.[2]).toEqual({ phone: '+15555550155', firstname: 'Jordan', lastname: 'Rivera' });
    const task = f.executeTool.mock.calls[4]?.[2] as Record<string, unknown>;
    expect(task.hs_task_subject).toBe('Follow up with Jordan Rivera (+15555550155)');
    expect(task.hubspot_owner_id).toBe('owner-1');
    expect(String(task.hs_timestamp)).toMatch(/T16:00:00\.000Z$/);
    expect(f.markDone).toHaveBeenCalledWith('call-1', 'done:crm:lead:lead-1');
  }, 60_000);

  it('an existing contact only gains the names it lacks; no owner is not an error', async () => {
    const f = withCrm();
    f.executeTool
      .mockResolvedValueOnce({ successful: true, data: { results: [{ id: '9', properties: { firstname: 'Jordan', lastname: null } }] } })
      .mockResolvedValueOnce({ successful: true, data: {} })
      .mockResolvedValueOnce({ successful: true, data: { id: 'n1' } })
      .mockRejectedValueOnce(new Error('no owners'))
      .mockResolvedValueOnce({ successful: true, data: { id: 't1' } });
    expect(await runWorkflow(env, f, crmLead, [lead])).toBe('done');
    expect(slugs(f)).toEqual(['HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_UPDATE_CONTACT', 'HUBSPOT_CREATE_NOTE', 'HUBSPOT_RETRIEVE_OWNERS', 'HUBSPOT_RETRIEVE_OWNERS', 'HUBSPOT_CREATE_TASK']);
    expect(f.executeTool.mock.calls[1]?.[2]).toEqual({ contactId: '9', properties: { lastname: 'Rivera' } });
    expect((f.executeTool.mock.calls[5]?.[2] as Record<string, unknown>).hubspot_owner_id).toBeUndefined();
  }, 60_000);

  it('skips without a CRM, without a phone, or when already synced', async () => {
    const f = fakes();
    f.readCall.mockResolvedValue({ done: false, transcript: [] });
    expect(await runWorkflow(env, f, crmLead, [lead])).toBe('skipped');
    const g = withCrm();
    expect(await runWorkflow(env, g, crmLead, [{ ...lead, lead: { ...lead.lead, phone: undefined } }])).toBe('skipped');
    const h = withCrm();
    h.readCall.mockResolvedValue({ done: true, transcript: [] });
    expect(await runWorkflow(env, h, crmLead, [lead])).toBe('skipped');
    expect(h.lookupTenant).not.toHaveBeenCalled();
  }, 60_000);
});

describe('crm call', () => {
  it('notes the transcript on a known contact, without the tool lines, and marks', async () => {
    const f = withCrm();
    f.readCall.mockResolvedValue({ done: false, transcript: [{ role: 'user', text: 'Hi <there>', at: 't' }, { role: 'tool', text: 'x', at: 't' }, { role: 'assistant', text: 'Hello', at: 't' }] });
    f.executeTool.mockResolvedValueOnce({ successful: true, data: { results: [{ id: '9' }] } }).mockResolvedValueOnce({ successful: true, data: { id: 'n1' } });
    expect(await runWorkflow(env, f, crmCall, [ended])).toBe('done');
    expect(f.readCall).toHaveBeenCalledWith('call-1', 'done:crm:call', true);
    const note = f.executeTool.mock.calls[1]?.[2] as { hs_note_body: string };
    expect(note.hs_note_body).toBe('Call to Deck Co line - 2 min, completed<br><br>Caller: Hi &lt;there&gt;<br>Agent: Hello<br><br>Call ID: call-1');
    expect(f.markDone).toHaveBeenCalledWith('call-1', 'done:crm:call');
  }, 60_000);

  it('skips an unknown caller, a failed call, an empty transcript, and a caller not in the CRM', async () => {
    expect(await runWorkflow(env, withCrm(), crmCall, [{ ...ended, callerPhone: undefined }])).toBe('skipped');
    expect(await runWorkflow(env, withCrm(), crmCall, [{ ...ended, status: 'failed' }])).toBe('skipped');
    expect(await runWorkflow(env, withCrm(), crmCall, [ended])).toBe('skipped');
    const f = withCrm();
    f.readCall.mockResolvedValue({ done: false, transcript: [{ role: 'user', text: 'hi', at: 't' }] });
    f.executeTool.mockResolvedValue({ successful: true, data: { results: [] } });
    expect(await runWorkflow(env, f, crmCall, [ended])).toBe('skipped');
    expect(f.markDone).not.toHaveBeenCalled();
  }, 60_000);
});

describe('owner alert', () => {
  it('reaches the owner with a Telegram id, marked urgent, with the caller', async () => {
    const f = withCrm();
    expect(await runWorkflow(env, f, ownerAlert, [notify])).toBe('done');
    expect(f.sendTelegram).toHaveBeenCalledWith(777, 'URGENT (Deck Co): Flooding at 12 Elm. Caller: +15555550155');
  }, 60_000);

  it('a tenant with no owner channel fails loudly', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...crmTenant, people: [{ name: 'Sam', role: 'employee' }] });
    expect((await failure(runWorkflow(env, f, ownerAlert, [notify]))).type).toBe('NoOwnerChannel');
    expect(f.sendTelegram).not.toHaveBeenCalled();
  }, 60_000);
});

describe('call ended', () => {
  it('meters the minutes, writes the transcript to the caller\'s memory without the tool lines, and marks', async () => {
    const f = fakes();
    f.readCall.mockResolvedValue({ done: false, transcript: [{ role: 'user', text: 'Hi', at: 't' }, { role: 'tool', text: 'x', at: 't' }, { role: 'assistant', text: 'Hello', at: 't' }] });
    expect(await runWorkflow(env, f, callEnded, [ended])).toBe('done');
    expect(f.readCall).toHaveBeenCalledWith('call-1', 'done:call.ended', true);
    expect(f.recordMeter).toHaveBeenCalledWith('deck', 'voice_minutes', 130 / 60, 'call-1');
    expect(f.rememberCall).toHaveBeenCalledWith('deck_15555550155', 'call-1', [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }]);
    expect(f.markDone).toHaveBeenCalledWith('call-1', 'done:call.ended');
  }, 60_000);

  it('skips a failed or zero-length call and one already handled; an unknown caller is metered but not remembered', async () => {
    expect(await runWorkflow(env, fakes(), callEnded, [{ ...ended, status: 'failed' }])).toBe('skipped');
    expect(await runWorkflow(env, fakes(), callEnded, [{ ...ended, durationSeconds: 0 }])).toBe('skipped');
    const f = fakes();
    f.readCall.mockResolvedValue({ done: true, transcript: [] });
    expect(await runWorkflow(env, f, callEnded, [ended])).toBe('skipped');
    expect(f.recordMeter).not.toHaveBeenCalled();
    const g = fakes();
    g.readCall.mockResolvedValue({ done: false, transcript: [{ role: 'user', text: 'Hi', at: 't' }] });
    expect(await runWorkflow(env, g, callEnded, [{ ...ended, callerPhone: undefined }])).toBe('done');
    expect(g.recordMeter).toHaveBeenCalled();
    expect(g.rememberCall).not.toHaveBeenCalled();
  }, 60_000);
});
