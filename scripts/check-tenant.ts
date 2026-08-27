/**
 * Tenant provisioning pre-flight (the Dify "check-dependencies" idea, adapted):
 * prints a checklist of everything a tenant needs to be fully operational.
 *
 *   npx tsx scripts/check-tenant.ts [tenantId]      (default: wnk)
 *
 * Checks config file <-> seeded table drift, secrets, Cedar scope, notification
 * wiring, and the owner's Google connection. Exit code 1 if any hard check fails.
 */
import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { BedrockAgentCoreClient, GetResourceOauth2TokenCommand, GetWorkloadAccessTokenForUserIdCommand } from '@aws-sdk/client-bedrock-agentcore';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dynamoStore, GOOGLE_GMAIL_SCOPES, GOOGLE_OAUTH_PARAMS, TenantConfigSchema } from '@wnk/shared';

const REGION = 'us-west-2';
const PREFIX = 'wnkinc-voice-dev';
const tenantId = process.argv[2] ?? 'wnk';

const out = (stack: string, key: string) =>
  execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

process.env.AWS_REGION ??= REGION;
process.env.TENANTS_TABLE = out('wnk-voice-dev', 'tenantsTableName');

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
else if (fileConfig && JSON.stringify(seeded) !== JSON.stringify(fileConfig)) warn('seeded config', 'table differs from file — re-seed or update the file (git is the source of truth)');
else ok('seeded config', 'matches the file');

// 3. CRM secret
const cfg = seeded ?? fileConfig;
if (cfg?.crm) {
  const sm = new SecretsManagerClient({ region: REGION });
  try {
    const s = await sm.send(new GetSecretValueCommand({ SecretId: `${PREFIX}/crm/${tenantId}` }));
    const token = (JSON.parse(s.SecretString ?? '{}') as { HUBSPOT_TOKEN?: string }).HUBSPOT_TOKEN ?? '';
    if (!token || token.startsWith('REPLACE')) bad('CRM secret', 'still a placeholder — put-secret-value the real token');
    else ok('CRM secret', 'real token present');
  } catch (err) {
    if (err instanceof ResourceNotFoundException) bad('CRM secret', `missing — add "${tenantId}" to the crm secret list in voice-stack.ts and deploy`);
    else bad('CRM secret', String(err).slice(0, 120));
  }
} else ok('CRM', 'not configured (crm: none)');

// 4. Cedar scope (source check — deployed policy can lag until cdk deploy)
const policySrc = readFileSync('packages/infrastructure/lib/policy-stack.ts', 'utf8');
if (policySrc.includes(`"${tenantId}"`)) ok('Cedar tenant guard', 'tenant id appears in policy-stack.ts (deploy wnk-policy-dev if changed)');
else bad('Cedar tenant guard', `"${tenantId}" not in policy-stack.ts — the voice agent's record_lead will be DENIED for this tenant`);

// 5. Notifications
if (cfg && !cfg.notifications.email && !cfg.notifications.sms) warn('notifications', 'no email/sms — the owner gets no notifier alerts (email agent still emails the Gmail owner)');
else if (cfg) ok('notifications', [cfg.notifications.email, cfg.notifications.sms].filter(Boolean).join(', '));

// 6. Google connection (owner's vault token for the email agent)
try {
  const ac = new BedrockAgentCoreClient({ region: REGION });
  const { workloadAccessToken } = await ac.send(new GetWorkloadAccessTokenForUserIdCommand({ workloadName: `${PREFIX}-email-responder`, userId: 'wesley' }));
  const res = await ac.send(new GetResourceOauth2TokenCommand({
    workloadIdentityToken: workloadAccessToken,
    resourceCredentialProviderName: `${PREFIX.replace(/-/g, '_')}_google`,
    scopes: GOOGLE_GMAIL_SCOPES,
    oauth2Flow: 'USER_FEDERATION',
    customParameters: GOOGLE_OAUTH_PARAMS,
  })).catch((err) => ({ accessToken: undefined, err: String(err) }));
  if (res.accessToken) ok('Google connection', 'vault has a live token (email agent can send)');
  else warn('Google connection', 'no vault token — run: npx tsx scripts/connect-google.ts');
} catch (err) {
  warn('Google connection', `check failed: ${String(err).slice(0, 100)}`);
}

// 7. Manual reminders (uncheckable from here)
console.log(`  ○ Twilio: number ${cfg?.phoneNumber ?? '?'} attached to the SIP trunk (verify in Twilio console)`);
console.log(`  ○ Employee login: a Cognito user with custom:businessId=${tenantId} (for the console)`);

console.log(failed ? '\nRESULT: NOT READY — fix the ✗ items' : '\nRESULT: READY (address ⚠ items as needed)');
process.exit(failed ? 1 : 0);
