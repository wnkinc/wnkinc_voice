/** The booking arithmetic: wall clock to instant and back, the day's window, and which slots a day has open. */
import { describe, expect, it } from 'vitest';
import { dayLabel, dayWindow, openSlots, slotAt, slotLabel, utcToZoned, zonedToUtc, type CalendarRules } from '../src/calendar.js';

const TZ = 'America/Los_Angeles';
const rules: CalendarRules = { slotMinutes: 30, horizonDays: 30, open: { start: '09:00', end: '12:00', days: [1, 2, 3, 4, 5] } };
// Monday 2026-09-28, 08:00 Pacific (PDT, -7).
const now = new Date('2026-09-28T15:00:00Z');

describe('wall clock and instants', () => {
  it('a Pacific wall-clock time is the instant seven hours later in summer, eight in winter', () => {
    expect(zonedToUtc('2026-09-28T09:00', TZ).toISOString()).toBe('2026-09-28T16:00:00.000Z');
    expect(zonedToUtc('2026-12-01T09:00', TZ).toISOString()).toBe('2026-12-01T17:00:00.000Z');
    expect(utcToZoned(new Date('2026-09-28T16:00:00Z'), TZ)).toBe('2026-09-28T09:00');
    expect(() => zonedToUtc('tomorrow at 9', TZ)).toThrow();
  });
  it('a day\'s window runs from local midnight to the next', () => {
    expect(dayWindow('2026-09-30', TZ)).toEqual({ timeMin: '2026-09-30T07:00:00.000Z', timeMax: '2026-10-01T07:00:00.000Z' });
    expect(() => dayWindow('9/30', TZ)).toThrow();
  });
  it('says a slot and a day the way a person would', () => {
    expect(slotLabel('2026-09-30T09:00')).toBe('9:00 AM');
    expect(slotLabel('2026-09-30T12:30')).toBe('12:30 PM');
    expect(slotLabel('2026-09-30T00:15')).toBe('12:15 AM');
    expect(dayLabel('2026-10-01')).toBe('Thursday, October 1');
  });
});

describe('open slots', () => {
  it('the grid inside the open hours, minus what is busy', () => {
    const busy = [{ start: '2026-09-30T16:15:00Z', end: '2026-09-30T17:15:00Z' }]; // 9:15-10:15 local
    expect(openSlots('2026-09-30', busy, rules, TZ, now).map((s) => s.label)).toEqual(['10:30 AM', '11:00 AM', '11:30 AM']);
    expect(openSlots('2026-09-30', busy, rules, TZ, now)[0]).toEqual({ local: '2026-09-30T10:30', startsAt: '2026-09-30T17:30:00.000Z', endsAt: '2026-09-30T18:00:00.000Z', label: '10:30 AM' });
  });
  it('nothing on a closed day, nothing already past, nothing beyond the horizon', () => {
    expect(openSlots('2026-10-03', [], rules, TZ, now)).toEqual([]); // Saturday
    expect(openSlots('2026-09-28', [], rules, TZ, new Date('2026-09-28T17:10:00Z')).map((s) => s.label)).toEqual(['10:30 AM', '11:00 AM', '11:30 AM']); // it is 10:10
    expect(openSlots('2026-11-02', [], rules, TZ, now)).toEqual([]); // 35 days out
  });
  it('a slot fits only when whole: a busy sliver anywhere in it removes it', () => {
    const busy = [{ start: '2026-09-30T16:55:00Z', end: '2026-09-30T17:05:00Z' }]; // 9:55-10:05 local
    expect(openSlots('2026-09-30', busy, rules, TZ, now).map((s) => s.label)).toEqual(['9:00 AM', '10:30 AM', '11:00 AM', '11:30 AM']);
  });
  it('slotAt admits a time on the grid inside the hours and refuses one off it', () => {
    expect(slotAt('2026-09-30T10:30', rules, TZ, now)?.startsAt).toBe('2026-09-30T17:30:00.000Z');
    expect(slotAt('2026-09-30T10:45', rules, TZ, now)).toBeUndefined();
    expect(slotAt('2026-09-30T13:00', rules, TZ, now)).toBeUndefined();
    expect(slotAt('2026-10-03T10:30', rules, TZ, now)).toBeUndefined();
    expect(slotAt('next tuesday', rules, TZ, now)).toBeUndefined();
  });
});
