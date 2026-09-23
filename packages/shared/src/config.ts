import { jsonSecret } from './secrets.js';
import { traceIdOf } from './trace.js';

// ---- Environment ------------------------------------------------------------

/** What the stacks set on the receptionist's Lambdas and the scripts. Read lazily so tests can override. */
export const env = {
  get tenantsTable() { return process.env.TENANTS_TABLE ?? ''; },
  get callsTable() { return process.env.CALLS_TABLE ?? ''; },
  get peopleTable() { return process.env.PEOPLE_TABLE ?? ''; },
  get eventBusName() { return process.env.EVENT_BUS_NAME ?? ''; },
  get eventSource() { return process.env.EVENT_SOURCE ?? 'wnkinc.voice'; },
  get openaiSecretArn() { return process.env.OPENAI_SECRET_ARN ?? ''; },
};

// ---- Secrets ----------------------------------------------------------------

export interface OpenAISecrets {
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
}

let secretsPromise: Promise<OpenAISecrets> | undefined;

/** OpenAI credentials from Secrets Manager (fetched once per process). Env vars override (tests). */
export function getOpenAISecrets(): Promise<OpenAISecrets> {
  secretsPromise ??= loadSecrets().catch((err) => {
    secretsPromise = undefined;
    throw err;
  });
  return secretsPromise;
}

async function loadSecrets(): Promise<OpenAISecrets> {
  const key = process.env.OPENAI_API_KEY;
  const secret = process.env.OPENAI_WEBHOOK_SECRET;
  if (key && secret) return { OPENAI_API_KEY: key, OPENAI_WEBHOOK_SECRET: secret };
  if (!env.openaiSecretArn) throw new Error('OPENAI_SECRET_ARN is not set');
  const parsed = await jsonSecret(env.openaiSecretArn) as Partial<OpenAISecrets>;
  if (!parsed.OPENAI_API_KEY || !parsed.OPENAI_WEBHOOK_SECRET) throw new Error('secret must contain OPENAI_API_KEY and OPENAI_WEBHOOK_SECRET');
  if (parsed.OPENAI_API_KEY.startsWith('REPLACE')) throw new Error('OpenAI secret still has placeholder values (see README "Configure secrets")');
  return { OPENAI_API_KEY: parsed.OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET: parsed.OPENAI_WEBHOOK_SECRET };
}


// ---- Logging ----------------------------------------------------------------

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

/** One JSON object per line; CloudWatch indexes the fields. LOG_LEVEL=debug|info|warn|error|silent. */
export function createLogger(ctx: Record<string, unknown> = {}): Logger {
  const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
    const min = process.env.LOG_LEVEL ?? 'info';
    if (min === 'silent' || LEVELS[level] < (LEVELS[min as Level] ?? LEVELS.info)) return;
    // The X-Ray trace id of the current Lambda invocation, so a Logs Insights
    // query by traceId finds every line from every function that touched a request.
    const traceId = traceIdOf(process.env._X_AMZN_TRACE_ID);
    const line: Record<string, unknown> = { level, msg, ts: new Date().toISOString(), ...(traceId ? { traceId } : {}), ...ctx };
    for (const [k, v] of Object.entries(data ?? {})) {
      line[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
    }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(JSON.stringify(line));
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (more) => createLogger({ ...ctx, ...more }),
  };
}
