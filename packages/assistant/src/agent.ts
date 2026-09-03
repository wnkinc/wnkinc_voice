/**
 * My Assistant — a tenant's own people chat with the platform about their
 * business. Runtime entrypoint: parse the channel-neutral payload, run one
 * turn (core.ts), deliver the reply on the channel it came from.
 *
 * Who may talk to it is decided before this runs: the Telegram workflow
 * (runtime stack) resolves the sender's Telegram id against the People table
 * and never invokes the agent for anyone else. The payload's tenantId is
 * therefore trusted the same way the voice tools' is — written by our code,
 * from an identity the channel vouched for.
 *
 * Credentials the agent holds: none of the tenant's. Cognito mints its Gateway
 * JWT, the Gateway holds the CRM key, and the OpenAI key and bot token come
 * from Secrets Manager.
 */
import { setDefaultOpenAIKey } from '@openai/agents';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { dynamoStore, gatewayClient, gatewayConfigFromEnv, memoryFromEnv, recordUsage, runtimeServer, type TraceContext } from '@wnk/shared';
import { z } from 'zod';
import { handleTurn, type CoreDeps } from './core.js';
import { sendTelegramMessage } from './telegram.js';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};

const PayloadSchema = z.object({
  tenantId: z.string().min(1),
  person: z.object({ name: z.string().min(1), role: z.enum(['owner', 'employee']) }),
  channelId: z.string().min(1),
  text: z.string().min(1),
  /** Where the reply goes. `none` returns it to the caller only (tests, scripts). */
  channel: z.discriminatedUnion('type', [
    z.object({ type: z.literal('telegram'), chatId: z.union([z.string(), z.number()]) }),
    z.object({ type: z.literal('none') }),
  ]),
});

const secrets = new SecretsManagerClient({});
async function secretJson(arn: string): Promise<Record<string, string>> {
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(res.SecretString ?? '{}') as Record<string, string>;
}

let ready: Promise<void> | undefined;
const init = (): Promise<void> => (ready ??= (async () => {
  const { OPENAI_API_KEY } = await secretJson(env('OPENAI_SECRET_ARN'));
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing from the OpenAI secret');
  setDefaultOpenAIKey(OPENAI_API_KEY);
})());

const gatewayConfig = gatewayConfigFromEnv();
const deps: CoreDeps = {
  store: dynamoStore(),
  gateway: gatewayConfig ? gatewayClient(gatewayConfig) : undefined,
  memory: memoryFromEnv(),
  model: process.env.ASSISTANT_MODEL ?? 'gpt-5-mini',
};

runtimeServer('assistant', async (raw: unknown, trace: TraceContext) => {
  await init();
  const payload = PayloadSchema.parse(raw);
  const ctx = { tenantId: payload.tenantId, channelId: payload.channelId, traceId: trace.traceId };
  console.log(JSON.stringify({ msg: 'turn received', role: payload.person.role, chars: payload.text.length, ...ctx }));

  const out = await handleTurn(deps, payload);
  if (out.tokens > 0) await recordUsage(payload.tenantId, 'llm_tokens', out.tokens, payload.channelId);
  if (out.skipped || !out.reply) return { ok: true, skipped: out.skipped ?? 'empty reply' };

  let delivered = 0;
  if (payload.channel.type === 'telegram') {
    const { TELEGRAM_BOT_TOKEN } = await secretJson(env('TELEGRAM_SECRET_ARN'));
    if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing from the Telegram secret');
    delivered = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, payload.channel.chatId, out.reply);
  }
  console.log(JSON.stringify({ msg: 'reply delivered', channel: payload.channel.type, messages: delivered, ...ctx }));
  return { ok: true, reply: out.reply, delivered };
});
