/**
 * Tenant service profile: what this tenant is getting, in plain language.
 *
 *   npx tsx scripts/tenant-profile.ts <tenantId>          # from the seeded row
 *   npx tsx scripts/tenant-profile.ts tenants/<id>.json   # from a config file
 *
 * Derived from the tenant row alone, using the same gates the workflows use,
 * so the profile cannot claim a service the platform would refuse. The
 * pre-flight (check-tenant.ts) asks "is it wired up"; this asks "what do
 * they get". Writes Markdown to tenant-profiles/<id>.md (gitignored) and
 * prints the path.
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
  source = 'seeded row';
}

// ---- Derivation: config -> services. Mirrors the workflow gates. -----------
const crm = cfg.crm?.type === 'hubspot' && cfg.crm.via === 'composio';
const owners = cfg.people.filter((p) => p.role === 'owner' && p.telegramId !== undefined);
const onTelegram = cfg.people.filter((p) => p.telegramId !== undefined);
const alerts = cfg.tools.includes('notify_owner') && owners.length > 0;
const assistant = cfg.products.assistant.enabled && !!cfg.composioMcpUrl;
const browser = cfg.products.browser.enabled && owners.length > 0;
const email = cfg.products.emailResponder.enabled;
const minutes = Math.round(cfg.maxCallSeconds / 60);

const yes = (on: boolean) => (on ? 'On' : 'Off');
const names = (ps: typeof cfg.people) => ps.map((p) => p.name).join(', ');
const lines: string[] = [];
const h = (s: string) => lines.push('', `## ${s}`, '');
const p = (s: string) => lines.push(s);
const li = (s: string) => lines.push(`- ${s}`);

lines.push(`# ${cfg.businessName} — service profile`, '', `Tenant \`${cfg.tenantId}\`, from ${source}. ${cfg.active ? 'Active.' : '**Inactive: calls are rejected.**'}`);

h(`Phone receptionist — ${yes(cfg.active)}`);
p(`Callers to ${cfg.phoneNumber} are answered by "${cfg.agentName}" (voice ${cfg.voice}, model ${cfg.model}), around the clock. Calls are capped at ${minutes} minutes.`);
if (cfg.hours) p(`The receptionist knows the business hours: ${cfg.hours}.`);
if (cfg.services.length) p(`It can talk about: ${cfg.services.join(', ')}.`);
lines.push('', 'During a call it can:');
if (cfg.tools.includes('record_lead')) li('Take a lead: caller name, number, reason, preferred callback time.');
if (cfg.tools.includes('notify_owner')) li(alerts ? `Alert the owner on Telegram right away (${names(owners)}) when something is urgent.` : 'Alert the owner — **but no owner has a Telegram id, so every alert fails.**');
if (cfg.tools.includes('end_call')) li('End the call politely when the conversation is done.');
li(crm ? 'Recognize repeat callers from HubSpot and from what it remembers of earlier calls.' : 'Recognize repeat callers from what it remembers of earlier calls.');
if (cfg.extraInstructions) lines.push('', `Standing instructions: ${cfg.extraInstructions}`);

h(`After every call`);
li(`Call record kept for 90 days: who called, outcome, duration, transcript.`);
li(`Caller memory updated so the next call from that number starts with context.`);
li(`Voice minutes metered against the account.`);

h(`Lead follow-up email — ${yes(email)}`);
p(email
  ? `Each lead the receptionist records becomes a follow-up email sent from the owner's own Gmail (connected through Composio), enriched with ${crm ? 'the caller\'s HubSpot history and ' : ''}what the receptionist remembers about the caller.`
  : 'Leads are recorded but no email is sent.');

h(`CRM sync (HubSpot) — ${yes(crm)}`);
p(crm
  ? 'Every lead creates or updates a HubSpot contact with a note and a follow-up task for the owner. Every call is logged on the contact. The HubSpot login is the owner\'s own consent, held in Composio\'s vault.'
  : 'No CRM connected. Leads live in the call record and the follow-up email only.');

h(`Chat assistant (Telegram) — ${yes(assistant)}`);
if (assistant) {
  p(`${names(onTelegram) || 'Nobody'} can message the assistant on Telegram. It reaches the business systems the owner connected through Composio (${crm ? 'HubSpot, ' : ''}Gmail) and remembers each person's conversation, starting a fresh day at 3am ${cfg.timezone}.`);
} else if (cfg.products.assistant.enabled) {
  p('**Turned on but not working: no Composio session on the row.** Connect accounts and re-seed.');
} else p('Off.');

h(`Saved browser — ${yes(browser)}`);
if (browser) {
  p(`The owner (${names(owners)}) can type /login to the assistant and sign into any website over a live view. Logins persist in the business's own saved browser${cfg.browserContextId ? '' : ' (not created yet; the first /login creates it)'}.`);
} else if (cfg.products.browser.enabled) {
  p('**Turned on but unusable: no owner with a Telegram id.**');
} else p('Off.');

h('People');
if (cfg.people.length) cfg.people.forEach((x) => li(`${x.name} (${x.role})${x.telegramId !== undefined ? ' — Telegram' : ' — no channel yet'}`));
else p('Nobody listed. Alerts, the assistant, and the browser all need at least one person.');

h('Metered');
p(['voice minutes', email ? 'emails sent' : '', assistant ? 'assistant tokens' : ''].filter(Boolean).join(', ') + '.');

mkdirSync('tenant-profiles', { recursive: true });
const outPath = `tenant-profiles/${cfg.tenantId}.md`;
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(outPath);
