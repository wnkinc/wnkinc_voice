/**
 * appointment.requested -> the slot checked once more, the event on the
 * tenant's calendar, the caller told. The receptionist offered the slot from
 * free/busy minutes ago and another caller may have taken it since, so the
 * workflow asks the calendar again right before it writes; a slot that went
 * is a text to the caller and a word to the owner, never a second event on
 * top of the first. The once-marker first, then the tenant's flag; the create
 * is one attempt, since an unanswered create must not run twice; the mark
 * right after it, before the confirmations, which are harmless twice.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import { CALENDAR_TOOLS, type AppointmentRequested } from '@wnk/shared/contracts';
import { confirmationEmail, confirmationText, eventArgs, ownerConflictText, slotTakenText } from '../../rules/booking.js';
import { orElse } from '../common.js';
import { ok, type AutomationOutcome } from './common.js';

type Activities = typeof activities;
const rows = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const saas = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds', backoffCoefficient: 2 } });
const texts = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3, initialInterval: '2 seconds' } });
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 2 } });
/** The create: one attempt through Composio's own answer; a rejected or unanswered create fails the workflow, which alarms, rather than booking twice. */
const once = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 1 } });

export async function bookAppointment(event: AppointmentRequested): Promise<AutomationOutcome> {
  const a = event.appointment;
  const key = `done:calendar:appointment:${a.appointmentId}`;
  if ((await rows.readCall(event.callId, key)).done) return 'skipped';
  const tenant = await rows.lookupTenant(event.tenantPhoneNumber);
  if (!tenant || tenant.calendar?.enabled !== true) return 'skipped';
  const tenantId = tenant.tenantId;
  const calendarId = tenant.calendar.calendarId ?? 'primary';
  const text = (to: string, body: string) => texts.sendText(undefined, tenant.phoneNumber, to, body);

  // ---- The slot, asked again: intervals only, as during the call ----------
  const fb = await saas.executeTool(tenantId, CALENDAR_TOOLS.freeBusy.slug, { timeMin: a.startsAt, timeMax: a.endsAt, items: [{ id: calendarId }] }, CALENDAR_TOOLS.freeBusy.version);
  ok(fb, 'free/busy');
  const busy = (fb.data?.calendars?.[calendarId]?.busy ?? []) as { start: string; end: string }[];
  if (busy.length > 0) {
    if (a.phone) await text(a.phone, slotTakenText(tenant, a));
    const owner = tenant.people?.find((p) => p.role === 'owner' && p.telegramId);
    if (owner?.telegramId) await orElse(bestEffort.sendTelegram(owner.telegramId, ownerConflictText(tenant, a)), undefined);
    await rows.markDone(event.callId, key);
    return 'conflict';
  }

  // ---- The event, once; the mark; then the caller is told ------------------
  const created = await once.executeTool(tenantId, CALENDAR_TOOLS.createEvent.slug, eventArgs(calendarId, a, event.callId), CALENDAR_TOOLS.createEvent.version);
  if (created.successful !== true) throw ApplicationFailure.nonRetryable(`Composio answered successful=false for ${CALENDAR_TOOLS.createEvent.slug}; see the workflow history`, 'CreateRejected');
  await rows.markDone(event.callId, key, true);
  if (a.phone) await text(a.phone, confirmationText(tenant, a));
  // Email only when the caller asked and the tenant's Gmail is consented (the responder's flag is that consent's marker); a failure costs only the email.
  if (a.email && tenant.emailResponder?.enabled === true) {
    const { subject, body } = confirmationEmail(tenant, a);
    await orElse(bestEffort.executeTool(tenantId, 'GMAIL_SEND_EMAIL', { recipient_email: a.email, subject, body }), undefined);
  }
  return 'done';
}
