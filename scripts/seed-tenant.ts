/**
 * Upsert tenant config(s) into the Tenants table.
 *
 *   TENANTS_TABLE=<from stack output> npm run seed -- tenants/example.json
 *   TENANTS_TABLE=... npm run seed -- tenants/acme.json tenants/other.json
 */
import { readFileSync } from 'node:fs';
import { dynamoStore } from '../src/store.js';

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
    console.log(`seeded ${t.tenantId} (${t.phoneNumber}) from ${file}`);
  }
}
