/** The automations' pure rules, with the tests the Step Functions expressions had. */
import { describe, expect, it } from 'vitest';
import { expectedToolkits, missingToolkits, nextBusinessMorning, splitName } from '../src/automations/catalog.js';
import type { TenantRow } from '@wnk/shared/contracts';

describe('nextBusinessMorning', () => {
  // Pacific in September: zoneOffset -420 -> seed offset 600.
  const at = (iso: string) => nextBusinessMorning(600, Date.parse(iso));
  it('Friday afternoon -> Monday 09:00 PDT (16:00Z)', () => { expect(at('2026-09-04T22:00:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Monday 08:59 local -> same day 09:00', () => { expect(at('2026-09-07T15:59:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Monday 09:00 local -> Tuesday', () => { expect(at('2026-09-07T16:00:00Z')).toBe('2026-09-08T16:00:00.000Z'); });
  it('Saturday -> Monday', () => { expect(at('2026-09-05T18:00:00Z')).toBe('2026-09-07T16:00:00.000Z'); });
  it('Eastern (seed offset 420): Friday evening -> Monday 09:00 EDT (13:00Z)', () => {
    expect(nextBusinessMorning(420, Date.parse('2026-09-04T23:00:00Z'))).toBe('2026-09-07T13:00:00.000Z');
  });
});

describe('expected toolkits', () => {
  const row = (crm: boolean, email: boolean, facebook = false): TenantRow => ({ tenantId: 't', phoneNumber: '+1', business: { name: 'x' }, crm: crm ? { type: 'hubspot', via: 'composio' } : undefined, emailResponder: { enabled: email }, facebookPosts: { enabled: facebook } });
  it('expects hubspot for crm via composio and gmail for the email responder', () => {
    expect(expectedToolkits(row(true, true))).toEqual(['hubspot', 'gmail']);
    expect(expectedToolkits(row(true, false))).toEqual(['hubspot']);
    expect(expectedToolkits(row(false, false))).toEqual([]);
  });
  it('expects facebook for Facebook posts, and nothing for a row written before the service existed', () => {
    expect(expectedToolkits(row(true, true, true))).toEqual(['hubspot', 'gmail', 'facebook']);
    expect(expectedToolkits(row(false, false, true))).toEqual(['facebook']);
    expect(expectedToolkits({ tenantId: 't', phoneNumber: '+1', business: { name: 'x' }, emailResponder: { enabled: true } })).toEqual(['gmail']);
  });
  it('reports the expected toolkits Composio does not list as active', () => {
    expect(missingToolkits(['hubspot', 'gmail'], ['gmail'])).toEqual(['hubspot']);
    expect(missingToolkits(['hubspot'], ['hubspot', 'gmail'])).toEqual([]);
    expect(missingToolkits(['hubspot'], [])).toEqual(['hubspot']);
  });
});

describe('splitName', () => {
  it('first and the rest, trimmed; a single word has no last name', () => {
    expect(splitName('  Jordan Rivera Smith ')).toEqual({ name: 'Jordan Rivera Smith', first: 'Jordan', last: 'Rivera Smith' });
    expect(splitName('Cher')).toEqual({ name: 'Cher', first: 'Cher', last: '' });
  });
});
