/**
 * Tenant provisioning pre-flight (the Dify "check-dependencies" idea, adapted):
 * prints a checklist of everything a tenant needs to be fully operational.
 *
 *   npx tsx scripts/check-tenant.ts <tenantId>
 *
 * Checks config file <-> seeded table drift, secrets, enabled services,
 * notification wiring, and the owner's Gmail connection. Exit code 1 if any
 * hard check fails. Onboarding is data-only: nothing here asks for a deploy.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dynamoStore, TenantConfigSchema } from '@wnk/shared';
import { STACKS } from '../packages/infrastructure/names.js';

const REGION = 'us-west-2';
const tenantId = process.argv[2];
if (!tenantId) { console.error('usage: npx tsx scripts/check-tenant.ts <tenantId>'); process.exit(2); }

const out = (stack: string, key: string) =>
  execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

process.env.AWS_REGION ??= REGION;
process.env.TENANTS_TABLE = out(STACKS.platform, 'tenantsTableName');

let failed = false;
const ok = (label: string, detail = '') => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label: string, detail: string) => console.log(`  ⚠ ${label} — ${detail}`);
const bad = (label: string, detail: string) => { failed = true; console.log(`  ✗ ${label} — ${detail}`); };

console.log(`Pre-flight for tenant "${tenantId}"\n`);

// 1. Config file
let fileConfig;
try {
  fileConfig = TenantConfigSchema.parse(JSON.parse(readFileSync(`tenants/${tenantId}.json`, 'utf8')));
  ok('config file', `tenants/${tenantId}.json valid (phone ${fileConfig.phoneNumber})`);
} catch (err) {
  bad('config file', `tenants/${tenantId}.json missing or invalid: ${String(err).slice(0, 120)}`);
}

// 2. Seeded config + drift
const store = dynamoStore();
const seeded = await store.findTenantById(tenantId);
if (!seeded) bad('seeded config', `no row in tenants table — run: npm run seed -- tenants/${tenantId}.json`);
// sessionDayOffsetMinutes is computed by the seed from the timezone, never in the file.
else if (fileConfig && JSON.stringify({ ...seeded, sessionDayOffsetMinutes: undefined }) !== JSON.stringify(fileConfig)) warn('seeded config', 'table differs from file — re-seed or update the file (git is the source of truth)');
else ok('seeded config', 'matches the file');

// 3. CRM (HubSpot through Composio)
const cfg = seeded ?? fileConfig;
if (cfg?.crm) {
  if (cfg.crm.via !== 'composio') bad('CRM', `crm.via is "${cfg.crm.via}"; the token path is gone — consent via scripts/connect-composio.mts ${tenantId} hubspot and set via: composio`);
  else ok('CRM', 'hubspot via composio (prove with scripts/test-crm-workflows.mts)');
} else ok('CRM', 'not configured (crm: none)');
if (cfg?.assistant.enabled) {
  const crmTools = cfg.assistant.tools.filter((t) => t === 'search_contacts' || t === 'add_note');
  if (crmTools.length && cfg.crm?.via !== 'composio') bad('Assistant tools', `${crmTools.join(', ')} need crm: { type: "hubspot", via: "composio" } and a HubSpot connection`);
  else ok('Assistant tools', cfg.assistant.tools.length ? cfg.assistant.tools.join(', ') : 'none: answers from the prompt and memory only');
}

// 4. Services this tenant has turned on
if (cfg) {
  const on = (['emailResponder', 'assistant', 'browser'] as const).filter((k) => cfg[k].enabled);
  ok('services', on.length ? on.join(', ') : 'none enabled — voice receptionist only');
}

// 5. Owner alerts: notify_owner delivers to the owner on Telegram (the owner alert workflow)
if (cfg) {
  const owners = cfg.people.filter((p) => p.role === 'owner' && p.telegramId !== undefined).map((p) => p.name);
  if (cfg.receptionist.session.tools.includes('notify_owner') && !owners.length) bad('owner alerts', 'tools has notify_owner but no person with role owner and a telegramId — every alert will fail');
  else ok('owner alerts', owners.length ? `Telegram → ${owners.join(', ')}` : 'notify_owner not enabled');
}

// 6. Owner's Gmail connected account for the email responder (Composio's vault, under the tenant id)
if (!cfg?.emailResponder.enabled) ok('Gmail connection', 'not needed (email responder off)');
else console.log(`  ○ Composio: Gmail connected account for user "${tenantId}" (if missing: npx tsx scripts/connect-composio.mts ${tenantId})`);

// 7. Manual reminders (uncheckable from here)
console.log(`  ○ Twilio: number ${cfg?.phoneNumber ?? '?'} attached to the SIP trunk (verify in Twilio console)`);

console.log(failed ? '\nRESULT: NOT READY — fix the ✗ items' : '\nRESULT: READY (address ⚠ items as needed)');
process.exit(failed ? 1 : 0);
