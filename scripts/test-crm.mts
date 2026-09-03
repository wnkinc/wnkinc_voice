/**
 * Exercise the Composio HubSpot adapter for a tenant, read-only by default.
 *
 *   npx tsx scripts/test-crm.mts [tenantId] [phone]            # find contact + last note
 *   WRITE=1 npx tsx scripts/test-crm.mts [tenantId] [phone]    # also upsert, note, task on that contact
 *
 * Reads the API key from the runtime stack's Composio secret (or COMPOSIO_API_KEY).
 */
import { execFileSync } from 'node:child_process';
import { composioCrm } from '@wnk/shared/composio';

const tenantId = process.argv[2] ?? 'wnk';
const phone = process.argv[3] ?? '+15555550100';
if (!process.env.COMPOSIO_API_KEY && !process.env.COMPOSIO_SECRET_ARN) {
  process.env.COMPOSIO_SECRET_ARN = execFileSync('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', 'wnk-runtime-dev',
    '--query', "Stacks[0].Outputs[?OutputKey=='composioSecretArn'].OutputValue | [0]", '--output', 'text', '--region', 'us-west-2',
  ], { encoding: 'utf8' }).trim();
}
const crm = composioCrm(tenantId);
const found = await crm.findContactByPhone(phone);
console.log('findContactByPhone:', found ?? 'no match');
if (found) console.log('lastNote:', await crm.lastNote(found.id));
if (process.env.WRITE) {
  const c = await crm.upsertContact({ phone, firstName: 'Composio', lastName: 'Smoke Test' });
  console.log('upsertContact:', c);
  await crm.addNote(c.id, `Composio adapter smoke test\nat ${new Date().toISOString()}`);
  await crm.addTask(c.id, { subject: 'Composio adapter smoke task', body: 'delete me', dueAt: new Date(Date.now() + 3_600_000) });
  console.log('note + task created; lastNote now:', await crm.lastNote(c.id));
}
