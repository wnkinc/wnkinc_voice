/**
 * Upsert tenant config(s) into the Tenants table.
 *
 *   TENANTS_TABLE=<from stack output> PEOPLE_TABLE=<from stack output> npm run seed -- tenants/example.json
 *   TENANTS_TABLE=... PEOPLE_TABLE=... npm run seed -- tenants/acme.json tenants/other.json
 *
 * Also mirrors the tenant's `people` into the People table (one row per channel
 * identity) and removes rows this tenant no longer lists — that is how someone
 * gains or loses access to the assistant. No deploy.
 *
 * And, when the assistant is on, mints the tenant's Composio meta-tools MCP
 * session (bound to the owner's connected accounts) and writes its URL back
 * as `composioMcpUrl`. Needs COMPOSIO_SECRET_ARN (voice stack output) or
 * COMPOSIO_API_KEY; the owner must have run connect-composio first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dynamoStore } from '@wnk/shared';
import { composioAssistant } from '@wnk/shared/composio';

/** The assistant's SaaS tools: one Composio meta-tools session per tenant. */
async function ensureComposioSession(raw: { tenantId?: string; composioMcpUrl?: string; products?: { assistant?: { enabled?: boolean } } }, file: string): Promise<void> {
  if (raw.composioMcpUrl || !raw.tenantId || !raw.products?.assistant?.enabled) return;
  if (!process.env.COMPOSIO_SECRET_ARN && !process.env.COMPOSIO_API_KEY) {
    console.warn(`${raw.tenantId}: assistant is on but no composioMcpUrl and COMPOSIO_SECRET_ARN unset; the assistant has no SaaS tools until one exists`);
    return;
  }
  const s = await composioAssistant.ensureSession(raw.tenantId);
  raw.composioMcpUrl = s.url;
  writeBack(file, raw.tenantId, 'composioMcpUrl', s.url);
  console.log(`minted Composio session for ${raw.tenantId}: ${s.sessionId} (toolkits: ${s.toolkits.join(', ')})`);
}

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

/** Write a minted value back next to tenantId, keeping the file's formatting. */
function writeBack(file: string, tenantId: string, key: string, value: string): void {
  const text = readFileSync(file, 'utf8');
  const marker = `"tenantId": "${tenantId}"`;
  if (text.includes(marker) && !text.includes(`"${key}"`)) {
    writeFileSync(file, text.replace(marker, `${marker},\n  "${key}": "${value}"`));
  } else {
    console.warn(`add "${key}": "${value}" to ${file} by hand`);
  }
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
    await ensureComposioSession(raw as Parameters<typeof ensureComposioSession>[0], file);
    const tz = (raw as { timezone?: string }).timezone ?? 'America/Los_Angeles';
    (raw as { sessionDayOffsetMinutes?: number }).sessionDayOffsetMinutes = sessionDayOffsetMinutes(tz);
    const t = await store.putTenant(raw as Parameters<typeof store.putTenant>[0]);
    const people = await store.syncPeople(t);
    console.log(`seeded ${t.tenantId} (${t.phoneNumber}) from ${file}; people: ${people.map((p) => `${p.name}=${p.channelId}`).join(', ') || 'none'}; session day rolls at 3 AM ${t.timezone} (UTC-${t.sessionDayOffsetMinutes}min)`);
  }
}
