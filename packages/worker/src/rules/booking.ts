/**
 * The booking workflow's rules, as pure functions: the calendar event's
 * arguments, and what the caller and the owner are told. The event names
 * the caller in its text and carries no attendees: the calendar is the
 * owner's, and a phone call must never put an email address on an invite.
 */
import { dayLabel, slotLabel } from '@wnk/shared/calendar';
import type { Appointment, TenantRow } from '@wnk/shared/contracts';

/** "Thursday, October 1 at 2:00 PM". */
export const whenSpoken = (a: Appointment): string => `${dayLabel(a.local.slice(0, 10))} at ${slotLabel(a.local)}`;

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** GOOGLECALENDAR_CREATE_EVENT's arguments: the wall-clock start in the tenant's zone, the duration split as the tool wants it, the caller as text. Never attendees. */
export function eventArgs(calendarId: string, a: Appointment, callId: string): Record<string, unknown> {
  return {
    calendar_id: calendarId,
    summary: `${a.callerName.trim()} - ${a.reason.trim()}`.slice(0, 200),
    description: [`Booked by the phone receptionist.`, `Caller: ${a.callerName.trim()}`, a.phone ? `Phone: ${a.phone}` : '', a.email ? `Email: ${a.email}` : '', `Reason: ${a.reason.trim()}`, '', `Call ${callId}`].filter((l) => l !== '').join('\n'),
    start_datetime: `${a.local}:00`,
    timezone: a.timezone,
    event_duration_hour: Math.floor(a.durationMinutes / 60),
    event_duration_minutes: a.durationMinutes % 60,
  };
}

/** The caller's confirmation, texted from the business's number. */
export const confirmationText = (t: TenantRow, a: Appointment): string =>
  `Hi ${first(a.callerName)}, this is ${t.business.name}. You're booked for ${whenSpoken(a)}. To change it, reply here or call ${t.phoneNumber}.`;

/** The caller, when the slot went between the call and the booking. */
export const slotTakenText = (t: TenantRow, a: Appointment): string =>
  `Hi ${first(a.callerName)}, this is ${t.business.name}. Sorry, the ${whenSpoken(a)} slot was taken just before we could hold it. Reply here or call ${t.phoneNumber} and we'll find another time.`;

/** The owner, for the same case: a person resolves it. */
export const ownerConflictText = (t: TenantRow, a: Appointment): string =>
  `Booking conflict (${t.business.name}): ${a.callerName.trim()} asked for ${whenSpoken(a)} but the slot was taken first. They were told to reply or call back.${a.phone ? ` Caller: ${a.phone}` : ''}`;

/** The caller's confirmation by email, when they asked for one. */
export const confirmationEmail = (t: TenantRow, a: Appointment): { subject: string; body: string } => ({
  subject: `Your appointment with ${t.business.name}: ${whenSpoken(a)}`,
  body: `Hi ${first(a.callerName)},\n\nYou're booked with ${t.business.name} for ${whenSpoken(a)} (${a.timezone}).\n\nReason: ${a.reason.trim()}\n\nTo change it, call ${t.phoneNumber}.\n`,
});
