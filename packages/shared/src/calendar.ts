/**
 * Booking arithmetic, pure: the business's wall clock in and out of UTC, and
 * the slots a day has open once its busy intervals are known. The
 * receptionist offers slots from this during a call; the worker names one
 * back in a confirmation. Free/busy carries intervals and nothing else, so
 * this is the whole of what the platform knows about a calendar.
 */

/** A busy interval as Google's free/busy answers it: two RFC 3339 instants. */
export interface Busy { start: string; end: string }

/** The tenant row's calendar block, the parts the arithmetic reads. */
export interface CalendarRules {
  slotMinutes: number;
  horizonDays: number;
  open: { start: string; end: string; days: number[] };
}

/** One bookable slot: its wall-clock start (`YYYY-MM-DDTHH:MM`), its instants, and how it is said. */
export interface Slot { local: string; startsAt: string; endsAt: string; label: string }

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes the zone is ahead of UTC at that instant. */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant of a wall-clock time in the zone. Across a DST gap, the later reading. */
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = LOCAL.exec(local);
  if (!m) throw new Error(`not a local time (YYYY-MM-DDTHH:MM): ${local}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let t = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  t = naive - zoneOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

/** The wall-clock time of an instant in the zone, `YYYY-MM-DDTHH:MM`. */
export function utcToZoned(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** The instants a local date starts and ends in the zone: the free/busy window for that day. */
export function dayWindow(date: string, timeZone: string): { timeMin: string; timeMax: string } {
  if (!DATE.test(date)) throw new Error(`not a date (YYYY-MM-DD): ${date}`);
  const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1)).toISOString().slice(0, 10);
  return { timeMin: zonedToUtc(`${date}T00:00`, timeZone).toISOString(), timeMax: zonedToUtc(`${next}T00:00`, timeZone).toISOString() };
}

/** Day of the week of a local date, Sunday 0. */
export const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** "9:30 AM", as it is said. */
export function slotLabel(local: string): string {
  const [h, mi] = local.slice(11).split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${pad(mi)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Thursday, October 1". */
export const dayLabel = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const overlaps = (start: number, end: number, b: Busy) => start < Date.parse(b.end) && end > Date.parse(b.start);

/**
 * The slots a day has open: on the slot grid inside the open hours, on an
 * open day, after `now`, inside the horizon, and clear of every busy
 * interval. Empty on a closed day.
 */
export function openSlots(date: string, busy: Busy[], rules: CalendarRules, timeZone: string, now: Date): Slot[] {
  if (!DATE.test(date)) throw new Error(`not a date (YYYY-MM-DD): ${date}`);
  if (!rules.open.days.includes(weekday(date))) return [];
  const horizon = now.getTime() + rules.horizonDays * 86_400_000;
  const out: Slot[] = [];
  for (let m = minutesOf(rules.open.start); m + rules.slotMinutes <= minutesOf(rules.open.end); m += rules.slotMinutes) {
    const local = `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    const start = zonedToUtc(local, timeZone).getTime();
    const end = start + rules.slotMinutes * 60_000;
    if (start <= now.getTime() || start > horizon) continue;
    if (busy.some((b) => overlaps(start, end, b))) continue;
    out.push({ local, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), label: slotLabel(local) });
  }
  return out;
}

/** The slot at a wall-clock time if the rules allow one there (busy or not: the workflow asks the calendar again). */
export function slotAt(local: string, rules: CalendarRules, timeZone: string, now: Date): Slot | undefined {
  if (!LOCAL.test(local)) return undefined;
  return openSlots(local.slice(0, 10), [], rules, timeZone, now).find((s) => s.local === local);
}
