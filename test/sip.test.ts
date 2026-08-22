import { describe, expect, it } from 'vitest';
import { extractE164, identifyParties, normalizePhone } from '../src/sip.js';

describe('extractE164', () => {
  it('parses sip URIs with and without plus', () => {
    expect(extractE164('sip:+15555550100@sip.api.openai.com')).toBe('+15555550100');
    expect(extractE164('sip:15555550100@sip.api.openai.com')).toBe('+15555550100');
    expect(extractE164('"Caller" <sip:+15555550100@sip.twilio.com>;tag=xyz')).toBe('+15555550100');
    expect(extractE164('tel:+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects non-phone user parts', () => {
    expect(extractE164('sip:proj_abc123def456@sip.api.openai.com')).toBeUndefined();
    expect(extractE164('sip:anonymous@anonymous.invalid')).toBeUndefined();
    expect(extractE164(undefined)).toBeUndefined();
  });
});

describe('identifyParties', () => {
  it('uses To/From by default', () => {
    expect(identifyParties([
      { name: 'From', value: 'sip:+15555550123@x' },
      { name: 'to', value: 'sip:+15555550100@y' },
    ])).toEqual({ from: '+15555550123', to: '+15555550100' });
  });
  it('falls back to alternative headers when To carries the project id', () => {
    expect(identifyParties([
      { name: 'From', value: 'sip:+15555550123@x' },
      { name: 'To', value: 'sip:proj_abc@sip.api.openai.com' },
      { name: 'P-Called-Party-ID', value: '<sip:+15555550100@carrier>' },
    ])).toEqual({ from: '+15555550123', to: '+15555550100' });
  });
});

describe('normalizePhone', () => {
  it('handles NANP formats', () => {
    expect(normalizePhone('5555550111')).toBe('+15555550111');
    expect(normalizePhone('1-555-555-0111')).toBe('+15555550111');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('123')).toBeUndefined();
  });
});
