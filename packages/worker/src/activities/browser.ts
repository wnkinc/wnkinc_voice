/**
 * Browserbase: the tenant's saved browser (a context: cookies and logins,
 * encrypted in their vault) and a live session on it. One platform project;
 * each tenant's context is named by its tenant id and keyed on the row.
 */
import { env, secret } from './config.js';

export const BROWSERBASE_API = 'https://api.browserbase.com/v1/';

async function api(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const s = await secret(env('BROWSERBASE_SECRET_ARN'));
  if (!s.BROWSERBASE_API_KEY) throw new Error('the Browserbase secret is not filled in');
  const res = await fetch(BROWSERBASE_API + path, {
    method, headers: { 'X-BB-API-Key': s.BROWSERBASE_API_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Browserbase ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json() as Record<string, any>;
}

const project = () => env('BROWSERBASE_PROJECT_ID');

/** A new saved browser for the tenant. Its id goes on the tenant row. */
export async function createBrowserContext(tenantId: string): Promise<string> {
  return (await api('POST', 'contexts', { projectId: project(), name: tenantId })).id as string;
}

/** A live browser on the context, held open for the owner; `timeoutSeconds` is Browserbase's backstop past our own release. */
export async function startBrowserSession(contextId: string, timeoutSeconds: number): Promise<string> {
  return (await api('POST', 'sessions', {
    projectId: project(),
    browserSettings: { context: { id: contextId, persist: true }, solveCaptchas: true },
    keepAlive: true,
    timeout: timeoutSeconds,
  })).id as string;
}

export async function browserLiveView(sessionId: string): Promise<string> {
  return (await api('GET', `sessions/${sessionId}/debug`)).debuggerUrl as string;
}

/** Release syncs the context so what the owner signed into is kept. */
export async function releaseBrowserSession(sessionId: string): Promise<void> {
  await api('POST', `sessions/${sessionId}`, { projectId: project(), status: 'REQUEST_RELEASE' });
}
