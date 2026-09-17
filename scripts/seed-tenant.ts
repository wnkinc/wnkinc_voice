/**
 * Upsert tenant config(s) into the Tenants table.
 *
 *   TENANTS_TABLE=<from stack output> PEOPLE_TABLE=<from stack output> npm run seed -- tenants/example.json
 *   TENANTS_TABLE=... PEOPLE_TABLE=... npm run seed -- tenants/acme.json tenants/other.json
 *
 * Also mirrors the tenant's `people` into the People table (one row per channel
 * identity) and removes rows this tenant no longer lists — that is how someone
 * gains or loses access to the assistant. No deploy.
 */
import { readFileSync } from 'node:fs';
import { dynamoStore } from '@wnk/shared';

/**
 * Minutes to subtract from UTC so days roll at 3 AM local: 180 minus the
 * zone's current UTC offset (PDT, -420 -> 600: the day rolls at 10:00Z).
 * Derived, not stored in the file; recomputed on every seed.
 */
export function sessionDayOffsetMinutes(timeZone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes());
  const zoneOffset = Math.round((localAsUtc - utc) / 60_000);
  return 180 - zoneOffset;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run seed -- <tenant.json> [...]');
  process.exit(1);
}
const store = dynamoStore();
for (const file of files) {
  const list = [JSON.parse(readFileSync(file, 'utf8')) as unknown]; // one tenant per file, named tenants/<tenantId>.json
  for (const raw of list) {
    const tz = (raw as { business?: { timezone?: string } }).business?.timezone ?? 'America/Los_Angeles';
    (raw as { sessionDayOffsetMinutes?: number }).sessionDayOffsetMinutes = sessionDayOffsetMinutes(tz);
    const t = await store.putTenant(raw as Parameters<typeof store.putTenant>[0]);
    const people = await store.syncPeople(t);
    console.log(`seeded ${t.tenantId} (${t.phoneNumber}) from ${file}; people: ${people.map((p) => `${p.name}=${p.channelId}`).join(', ') || 'none'}; session day rolls at 3 AM ${t.business.timezone} (UTC-${t.sessionDayOffsetMinutes}min)`);
  }
}
