/**
 * Back-office agent — AgentCore Runtime + AgentCore Browser.
 *
 * Give it a question and a URL; it starts a managed browser session, drives it
 * over CDP (the SigV4-signed automation WebSocket — no playwright, ~80 lines),
 * extracts the page text, and answers the question with OpenAI.
 *
 * v1 is invoked directly (scripts/test-backoffice.mts). Later: attach as an MCP
 * connector so employees can hand it research tasks from Claude/ChatGPT.
 */
import { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { dynamoStore, recordUsage, requireTenant, traceContextFromHeaders, type TraceContext } from '@wnk/shared';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import * as http from 'node:http';
import WebSocket from 'ws';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};
const REGION = process.env.AWS_REGION ?? 'us-west-2';

// ---- CDP over the signed automation stream ----------------------------------

async function signedWebSocket(endpoint: string): Promise<WebSocket> {
  const url = new URL(endpoint);
  console.log(JSON.stringify({ msg: 'connecting automation stream', host: url.hostname, path: url.pathname, query: url.search }));
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  const signer = new SignatureV4({ credentials: defaultProvider(), region: REGION, service: 'bedrock-agentcore', sha256: Sha256 });
  const signed = await signer.sign(new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: { host: url.hostname },
  }));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers: signed.headers as Record<string, string>, handshakeTimeout: 15_000 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

interface Cdp {
  send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

function cdp(ws: WebSocket): Cdp {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      });
    },
    close: () => ws.close(),
  };
}

async function browsePage(url: string): Promise<{ title: string; text: string }> {
  const client = new BedrockAgentCoreClient({ region: REGION });
  const session = await client.send(new StartBrowserSessionCommand({
    browserIdentifier: env('BROWSER_ID'),
    name: 'back-office-task',
    sessionTimeoutSeconds: 300,
  }));
  const endpoint = session.streams?.automationStream?.streamEndpoint;
  if (!endpoint || !session.sessionId) throw new Error('browser session has no automation stream');
  try {
    const c = cdp(await signedWebSocket(endpoint));
    try {
      const targets = (await c.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string }> };
      const page = targets.targetInfos.find((t) => t.type === 'page');
      if (!page) throw new Error('no page target in browser session');
      const attach = (await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })) as { sessionId: string };
      const s = attach.sessionId;
      await c.send('Page.enable', {}, s);
      await c.send('Page.navigate', { url }, s);
      // Wait for the document instead of wiring load events.
      for (let i = 0; i < 30; i++) {
        const ready = await c.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, s) as { result?: { value?: string } };
        if (ready.result?.value === 'complete') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const evaluate = async (expression: string) =>
        ((await c.send('Runtime.evaluate', { expression, returnByValue: true }, s)) as { result?: { value?: string } }).result?.value ?? '';
      const title = await evaluate('document.title');
      const text = await evaluate('document.body.innerText');
      return { title, text: text.slice(0, 14_000) };
    } finally {
      c.close();
    }
  } finally {
    await client.send(new StopBrowserSessionCommand({ browserIdentifier: env('BROWSER_ID'), sessionId: session.sessionId })).catch(() => {});
  }
}

let answerTokens = 0; // set by answer() per invocation; read by the meter

// ---- Answering --------------------------------------------------------------

async function answer(question: string, page: { title: string; text: string }, url: string): Promise<string> {
  const sm = new SecretsManagerClient({ region: REGION });
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: env('OPENAI_SECRET_ARN') }));
  const { OPENAI_API_KEY } = JSON.parse(secret.SecretString ?? '{}') as { OPENAI_API_KEY?: string };
  if (!OPENAI_API_KEY) throw new Error('no OpenAI key');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.EMAIL_MODEL ?? 'gpt-5-mini',
      messages: [
        { role: 'system', content: 'Answer the question using only the provided page content. Two or three sentences. If the page does not answer it, say so.' },
        { role: 'user', content: `Question: ${question}\n\nPage: ${page.title} (${url})\n\n${page.text}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens?: number } };
  answerTokens = data.usage?.total_tokens ?? 0;
  return data.choices[0]?.message.content ?? '';
}

// ---- Runtime HTTP contract ---------------------------------------------------

interface Task { question?: string; url?: string; tenantId?: string }

const store = dynamoStore();

async function processTask(task: Task, trace: TraceContext): Promise<{ ok: boolean; answer: string; title: string; url: string }> {
  if (!task.question || !task.url) throw new Error('payload needs { question, url, tenantId }');
  const tenant = await requireTenant(store, task.tenantId);
  if (!tenant.products.backOffice.enabled) throw new Error(`back office is not enabled for tenant "${tenant.tenantId}"`);
  const tenantId = tenant.tenantId;
  const ctx = { tenantId, traceId: trace.traceId };
  console.log(JSON.stringify({ msg: 'task received', ...ctx, question: task.question, url: task.url }));
  const page = await browsePage(task.url);
  console.log(JSON.stringify({ msg: 'page fetched', title: page.title, chars: page.text.length }));
  answerTokens = 0;
  const result = await answer(task.question, page, task.url);
  console.log(JSON.stringify({ msg: 'answered', ...ctx }));
  await recordUsage(tenantId, 'browser_tasks', 1, task.url);
  if (answerTokens > 0) await recordUsage(tenantId, 'llm_tokens', answerTokens, task.url);
  return { ok: true, answer: result, title: page.title, url: task.url };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/invocations')) {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const trace = traceContextFromHeaders(req.headers);
        try {
          const result = await processTask(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Task, trace);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (err) {
          console.error(JSON.stringify({ msg: 'task failed', err: String(err), ...trace }));
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
        }
      })();
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'back-office agent listening', port: 8080 })));
