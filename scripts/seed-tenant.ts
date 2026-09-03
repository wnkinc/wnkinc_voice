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

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run seed -- <tenant.json> [...]');
  process.exit(1);
}
const store = dynamoStore();
for (const file of files) {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const raw of list) {
    const t = await store.putTenant(raw as Parameters<typeof store.putTenant>[0]);
    const people = await store.syncPeople(t);
    console.log(`seeded ${t.tenantId} (${t.phoneNumber}) from ${file}; people: ${people.map((p) => `${p.name}=${p.channelId}`).join(', ') || 'none'}`);
  }
}
