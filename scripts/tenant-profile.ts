/**
 * Tenant profile: the tenant's row, human-readable, minus platform internals.
 *
 *   npx tsx scripts/tenant-profile.ts <tenantId>          # from the seeded row
 *   npx tsx scripts/tenant-profile.ts tenants/<id>.json   # from a config file
 *
 * A mirror, not a summary: every field is shown under its JSON name with its
 * exact value, so a change agreed on this page maps one-to-one onto the JSON
 * file. Hidden: ids and URLs the platform manages (tenantId, browserContextId,
 * browserLoginUntil, composioMcpUrl, sessionDayOffsetMinutes) and the receptionist
 * engine settings (model, voice, tools).
 * Writes tenant-profiles/<id>.md (gitignored) and prints the path.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dynamoStore, TenantConfigSchema, type TenantConfig } from '@wnk/shared';

const REGION = 'us-west-2';
const arg = process.argv[2];
if (!arg) { console.error('usage: npx tsx scripts/tenant-profile.ts <tenantId | tenants/<id>.json>'); process.exit(2); }

let cfg: TenantConfig;
let source: string;
if (arg.endsWith('.json')) {
  cfg = TenantConfigSchema.parse(JSON.parse(readFileSync(arg, 'utf8')));
  source = arg;
} else {
  process.env.AWS_REGION ??= REGION;
  process.env.TENANTS_TABLE = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', 'wnk-voice-dev', '--query',
    "Stacks[0].Outputs[?OutputKey=='tenantsTableName'].OutputValue | [0]", '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();
  const row = await dynamoStore().findTenantById(arg);
  if (!row) { console.error(`no tenant "${arg}" in the tenants table`); process.exit(1); }
  cfg = row;
  source = 'the seeded row';
}

const HIDDEN = new Set(['tenantId', 'browserContextId', 'browserLoginUntil', 'composioMcpUrl', 'sessionDayOffsetMinutes', 'model', 'voice', 'tools']);
const L: string[] = [`# ${cfg.businessName}`, '', `From ${source}. Field names are the JSON keys; values are exact.`, ''];

function show(key: string, value: unknown, depth = 0) {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) {
    L.push(`${pad}- **${key}**`);
    for (const v of value) {
      if (v && typeof v === 'object') L.push(`${pad}  - ${Object.entries(v).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(', ')}`);
      else L.push(`${pad}  - ${JSON.stringify(v)}`);
    }
  } else if (value && typeof value === 'object') {
    L.push(`${pad}- **${key}**`);
    for (const [k, v] of Object.entries(value)) show(k, v, depth + 1);
  } else {
    L.push(`${pad}- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
}
for (const [key, value] of Object.entries(cfg)) if (!HIDDEN.has(key)) show(key, value);

mkdirSync('tenant-profiles', { recursive: true });
const outPath = `tenant-profiles/${cfg.tenantId}.md`;
writeFileSync(outPath, L.join('\n') + '\n');
console.log(outPath);
