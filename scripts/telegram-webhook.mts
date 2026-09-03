/**
 * Point the Telegram bot at the platform (or show/remove the webhook).
 *
 *   npx tsx scripts/telegram-webhook.mts set      # register <apiEndpoint>/telegram/<WEBHOOK_PATH>
 *   npx tsx scripts/telegram-webhook.mts info     # what Telegram has now (pending updates, last error)
 *   npx tsx scripts/telegram-webhook.mts delete
 *
 * Reads the bot token and the generated path from the Telegram secret, and the
 * API endpoint from the voice stack, so the secret path never passes through a
 * terminal or a file. Set the token first:
 *   aws secretsmanager put-secret-value --secret-id <telegramSecretArn> \
 *     --secret-string "$(aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text \
 *       | jq -c '.TELEGRAM_BOT_TOKEN = "<token from BotFather>"')"
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { execFileSync } from 'node:child_process';

const action = process.argv[2] ?? 'info';
const output = (stack: string, key: string) =>
  execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', 'us-west-2'], { encoding: 'utf8' }).trim();

const secretArn = output('wnk-runtime-dev', 'telegramSecretArn');
const apiEndpoint = output('wnk-voice-dev', 'apiEndpoint');
const sm = new SecretsManagerClient({ region: 'us-west-2' });
const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? '{}') as { TELEGRAM_BOT_TOKEN?: string; WEBHOOK_PATH?: string };
if (!secret.TELEGRAM_BOT_TOKEN || secret.TELEGRAM_BOT_TOKEN === 'set-me') throw new Error(`TELEGRAM_BOT_TOKEN not set in ${secretArn}`);
if (!secret.WEBHOOK_PATH) throw new Error('WEBHOOK_PATH missing from the Telegram secret');

const api = async (method: string, body?: unknown) => {
  const res = await fetch(`https://api.telegram.org/bot${secret.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
};

if (action === 'set') {
  const url = `${apiEndpoint}/telegram/${secret.WEBHOOK_PATH}`;
  console.log(await api('setWebhook', { url, allowed_updates: ['message'], drop_pending_updates: true }));
} else if (action === 'delete') {
  console.log(await api('deleteWebhook'));
} else {
  const info = await api('getWebhookInfo');
  const r = (info.result ?? {}) as Record<string, unknown>;
  if (typeof r.url === 'string') r.url = r.url.replace(/\/telegram\/.*$/, '/telegram/<hidden>');
  console.log(JSON.stringify(r, null, 2));
}
