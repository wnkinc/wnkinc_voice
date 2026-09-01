/**
 * Live-view playground backend. Local only — talks to AgentCore with YOUR aws
 * credentials (same chain the CDK deploy uses). Endpoints:
 *
 *   GET  /api/context                         region + browsers (custom + default)
 *   GET  /api/sessions?browserId=             sessions for a browser
 *   POST /api/sessions                        { browserId, timeoutSeconds? } -> start
 *   DELETE /api/sessions?browserId=&sessionId=  stop
 *   GET  /api/live-url?browserId=&sessionId=  SigV4-presigned DCV live view URL
 *   POST /api/control                         { browserId, sessionId, takeControl } toggle automation stream
 *   POST /api/navigate                        { browserId, sessionId, url } drive via CDP (simulates the agent)
 */
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
  GetBrowserSessionCommand,
  ListBrowserSessionsCommand,
  UpdateBrowserStreamCommand,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient, ListBrowsersCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { randomUUID } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import * as http from 'node:http';
import WebSocket from 'ws';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const PORT = 8787;
// Must match the viewport the session is started with, or DCV crops/letterboxes.
export const VIEWPORT = { width: 1456, height: 819 };

const client = new BedrockAgentCoreClient({ region: REGION });
const control = new BedrockAgentCoreControlClient({ region: REGION });

const signer = () =>
  new SignatureV4({ credentials: defaultProvider(), region: REGION, service: 'bedrock-agentcore', sha256: Sha256 });

/** Query-presigned URL (browser WebSockets can't send signed headers).
 *  Docs gotcha: sign as https:, NOT wss: — the DCV client converts internally,
 *  and signing wss: makes the canonical request mismatch (silent 1006). */
async function presignLiveView(endpoint, expiresIn = 300) {
  const url = new URL(endpoint);
  const query = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  const signed = await signer().presign(
    new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers: { host: url.hostname },
    }),
    { expiresIn },
  );
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(signed.query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
  }
  return `https://${signed.hostname}${signed.path}?${qs.toString()}`;
}

/** Header-signed WS for the automation (CDP) stream — same as the agent. */
async function signedWebSocket(endpoint) {
  const url = new URL(endpoint);
  const query = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  const signed = await signer().sign(
    new HttpRequest({ method: 'GET', protocol: 'https:', hostname: url.hostname, path: url.pathname, query, headers: { host: url.hostname } }),
  );
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers: signed.headers, handshakeTimeout: 15_000 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
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

async function navigate(browserId, sessionId, targetUrl) {
  const session = await client.send(new GetBrowserSessionCommand({ browserIdentifier: browserId, sessionId }));
  const endpoint = session.streams?.automationStream?.streamEndpoint;
  if (!endpoint) throw new Error('session has no automation stream');
  const c = cdp(await signedWebSocket(endpoint));
  try {
    const targets = await c.send('Target.getTargets');
    const page = targets.targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const attach = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await c.send('Page.enable', {}, attach.sessionId);
    await c.send('Page.navigate', { url: targetUrl }, attach.sessionId);
  } finally {
    c.close();
  }
}

// ---- Routes -----------------------------------------------------------------

const routes = {
  'GET /api/context': async () => {
    const browsers = [{ browserId: 'aws.browser.v1', name: 'aws.browser.v1 (default)', kind: 'SYSTEM' }];
    try {
      const listed = await control.send(new ListBrowsersCommand({ maxResults: 50 }));
      for (const b of listed.browserSummaries ?? []) {
        if (b.browserId === 'aws.browser.v1') continue;
        browsers.unshift({ browserId: b.browserId, name: b.name ?? b.browserId, kind: 'CUSTOM', description: b.description });
      }
    } catch (err) {
      console.error('list browsers failed (continuing with default):', String(err));
    }
    return { region: REGION, viewport: VIEWPORT, browsers };
  },

  'GET /api/sessions': async (q) => {
    const out = await client.send(new ListBrowserSessionsCommand({ browserIdentifier: q.browserId, maxResults: 25 }));
    const items = (out.items ?? []).map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      status: s.status,
      createdAt: s.createdAt,
      lastUpdatedAt: s.lastUpdatedAt,
    }));
    // Newest first, live ones on top.
    items.sort((a, b) => (a.status === b.status ? new Date(b.createdAt) - new Date(a.createdAt) : a.status === 'READY' ? -1 : 1));
    return { items };
  },

  'POST /api/sessions': async (_q, body) => {
    const session = await client.send(new StartBrowserSessionCommand({
      browserIdentifier: body.browserId,
      name: body.name ?? 'live-view-playground',
      sessionTimeoutSeconds: body.timeoutSeconds ?? 900,
      viewPort: VIEWPORT,
    }));
    return { sessionId: session.sessionId, createdAt: session.createdAt };
  },

  'DELETE /api/sessions': async (q) => {
    await client.send(new StopBrowserSessionCommand({ browserIdentifier: q.browserId, sessionId: q.sessionId }));
    return { ok: true };
  },

  'GET /api/live-url': async (q) => {
    const session = await client.send(new GetBrowserSessionCommand({ browserIdentifier: q.browserId, sessionId: q.sessionId }));
    const endpoint = session.streams?.liveViewStream?.streamEndpoint;
    if (!endpoint) throw new Error('session has no live view stream (is it READY?)');
    const expiresIn = 300;
    return {
      url: await presignLiveView(endpoint, expiresIn),
      expiresAt: Date.now() + expiresIn * 1000,
      automationStreamStatus: session.streams?.automationStream?.streamStatus,
      sessionStatus: session.status,
      createdAt: session.createdAt,
      timeoutSeconds: session.sessionTimeoutSeconds,
      viewport: session.viewPort ?? VIEWPORT,
    };
  },

  'POST /api/control': async (_q, body) => {
    // Take control = suspend the automation (CDP) stream so human DCV input drives.
    await client.send(new UpdateBrowserStreamCommand({
      browserIdentifier: body.browserId,
      sessionId: body.sessionId,
      streamUpdate: { automationStreamUpdate: { streamStatus: body.takeControl ? 'DISABLED' : 'ENABLED' } },
    }));
    return { ok: true, automationStreamStatus: body.takeControl ? 'DISABLED' : 'ENABLED' };
  },

  'POST /api/navigate': async (_q, body) => {
    await navigate(body.browserId, body.sessionId, body.url);
    return { ok: true };
  },

  // Hand the deployed back-office agent a real task (same as scripts/test-backoffice.mts).
  'POST /api/task': async (_q, body) => {
    if (!body.question || !body.url) throw new Error('need { question, url }');
    const res = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: await backOfficeArn(),
      qualifier: 'DEFAULT',
      runtimeSessionId: `playground-${randomUUID()}-${randomUUID()}`,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify({ question: body.question, url: body.url })),
    }));
    const text = res.response ? Buffer.from(await res.response.transformToByteArray()).toString('utf8') : '{}';
    return JSON.parse(text);
  },
};

let arnPromise;
function backOfficeArn() {
  arnPromise ??= new CloudFormationClient({ region: REGION })
    .send(new DescribeStacksCommand({ StackName: process.env.RUNTIME_STACK ?? 'wnk-runtime-dev' }))
    .then((r) => {
      const out = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'backOfficeRuntimeArn');
      if (!out?.OutputValue) throw new Error('backOfficeRuntimeArn not found in stack outputs');
      return out.OutputValue;
    });
  return arnPromise;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) { res.writeHead(404).end(); return; }
  const q = Object.fromEntries(url.searchParams);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const result = await handler(q, body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (err) {
        console.error(`${req.method} ${url.pathname} failed:`, String(err));
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
      }
    })();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`live-view playground api on http://localhost:${PORT} (region ${REGION})`));
