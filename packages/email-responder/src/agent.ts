/**
 * Email responder — the first AgentCore Runtime agent.
 *
 * Triggered (via trigger.ts) by `lead.recorded`: enriches the lead with HubSpot
 * context through the Gateway (MCP), drafts a follow-up with OpenAI, and sends
 * it from the owner's own Gmail using the 3LO token in the Identity vault.
 * v1 emails the OWNER (leads from phone calls carry no email address).
 *
 * Credentials the agent holds: none. Cognito mints its Gateway JWT, the vault
 * hands it a scoped Google token, and the OpenAI key comes from Secrets Manager.
 */
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { callerMemory, GOOGLE_GMAIL_SCOPES, GOOGLE_OAUTH_PARAMS, recordUsage } from '@wnk/shared';
import * as http from 'node:http';

async function callerMemoryRecall(tenantId: string, phone: string): Promise<string[]> {
  return callerMemory(env('MEMORY_ID')).recall(tenantId, phone, 'who this caller is, their jobs, and their preferences');
}

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};
const REGION = process.env.AWS_REGION ?? 'us-west-2';

interface LeadEvent {
  lead?: { callerName?: string; phone?: string; reason?: string; preferredCallbackTime?: string; notes?: string };
  tenantId?: string;
  callId?: string;
}

// ---- Gateway (MCP) ----------------------------------------------------------

async function gatewayToken(): Promise<string> {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({
    UserPoolId: env('COGNITO_USER_POOL_ID'),
    ClientId: env('COGNITO_CLIENT_ID'),
  }));
  const res = await fetch(env('COGNITO_TOKEN_URL'), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${env('COGNITO_CLIENT_ID')}:${UserPoolClient?.ClientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials&scope=gateway%2Finvoke',
  });
  if (!res.ok) throw new Error(`cognito token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function callGatewayTool(token: string, name: string, args: unknown): Promise<string> {
  const res = await fetch(env('GATEWAY_URL'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = text.includes('data:') ? (text.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5) : text;
  const parsed = JSON.parse(data) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  if (parsed.result?.isError) throw new Error(`gateway tool ${name} failed: ${parsed.result.content?.[0]?.text}`);
  return parsed.result?.content?.[0]?.text ?? '';
}

// ---- Identity vault (Google) ------------------------------------------------

async function googleAccessToken(): Promise<string> {
  const agentcore = new BedrockAgentCoreClient({ region: REGION });
  const { workloadAccessToken } = await agentcore.send(new GetWorkloadAccessTokenForUserIdCommand({
    workloadName: env('WORKLOAD_NAME'),
    userId: env('OWNER_USER_ID'),
  }));
  const res = await agentcore.send(new GetResourceOauth2TokenCommand({
    workloadIdentityToken: workloadAccessToken,
    resourceCredentialProviderName: env('GOOGLE_PROVIDER_NAME'),
    scopes: GOOGLE_GMAIL_SCOPES,
    oauth2Flow: 'USER_FEDERATION',
    customParameters: GOOGLE_OAUTH_PARAMS, // part of the vault's cache key — must match the consent flow
  }));
  if (!res.accessToken) throw new Error('no Google token in the vault; the owner must run the Connect Google flow');
  return res.accessToken;
}

// ---- Drafting ---------------------------------------------------------------

let draftTokens = 0; // set by draftEmail per invocation; read by the meter

async function draftEmail(lead: NonNullable<LeadEvent['lead']>, crmContext: string): Promise<{ subject: string; body: string }> {
  draftTokens = 0;
  const fallback = {
    subject: `New lead: ${lead.callerName ?? 'unknown caller'} — ${lead.reason?.slice(0, 60) ?? 'phone inquiry'}`,
    body: [
      `New lead from the phone receptionist:`,
      ``,
      `Name: ${lead.callerName ?? 'unknown'}`,
      `Phone: ${lead.phone ?? 'unknown'}`,
      `Reason: ${lead.reason ?? 'not given'}`,
      lead.preferredCallbackTime ? `Preferred callback: ${lead.preferredCallbackTime}` : '',
      lead.notes ? `Notes: ${lead.notes}` : '',
      crmContext ? `\nCRM context:\n${crmContext.slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n'),
  };
  try {
    const sm = new SecretsManagerClient({ region: REGION });
    const secret = await sm.send(new GetSecretValueCommand({ SecretId: env('OPENAI_SECRET_ARN') }));
    const { OPENAI_API_KEY } = JSON.parse(secret.SecretString ?? '{}') as { OPENAI_API_KEY?: string };
    if (!OPENAI_API_KEY) return fallback;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.EMAIL_MODEL ?? 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You write short, useful internal emails for a home-services business owner. Reply with a JSON object {"subject": string, "body": string}. The body: 1) summarize the new lead in two sentences, 2) note anything relevant from CRM history, 3) suggest a 2-3 sentence text message the owner could send the lead. Plain text only.' },
          { role: 'user', content: `New lead: ${JSON.stringify(lead)}\n\nCRM history for this caller (JSON, may be empty): ${crmContext.slice(0, 3000)}` },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens?: number } };
    draftTokens = data.usage?.total_tokens ?? 0;
    const parsed = JSON.parse(data.choices[0]?.message.content ?? '{}') as { subject?: string; body?: string };
    if (parsed.subject && parsed.body) return { subject: parsed.subject, body: parsed.body };
    return fallback;
  } catch (err) {
    console.error('draft via OpenAI failed; using template', err);
    return fallback;
  }
}

// ---- Gmail ------------------------------------------------------------------

async function sendAsOwner(googleToken: string, subject: string, body: string): Promise<string> {
  const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${googleToken}` },
  });
  if (!profileRes.ok) throw new Error(`gmail profile: ${profileRes.status}`);
  const { emailAddress } = (await profileRes.json()) as { emailAddress: string };
  const rfc822 = [`To: ${emailAddress}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${googleToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(rfc822).toString('base64url') }),
  });
  if (!sendRes.ok) throw new Error(`gmail send: ${sendRes.status} ${await sendRes.text()}`);
  return emailAddress;
}

// ---- The agent --------------------------------------------------------------

async function processLead(event: LeadEvent): Promise<{ ok: boolean; sentTo: string; subject: string }> {
  const lead = event.lead ?? {};
  console.log(JSON.stringify({ msg: 'lead received', lead, callId: event.callId }));

  let crmContext = '';
  if (lead.phone) {
    try {
      const token = await gatewayToken();
      crmContext = await callGatewayTool(token, 'hubspot___searchContacts', { query: lead.phone.replace(/\D/g, '').slice(-10), limit: 3 });
      console.log(JSON.stringify({ msg: 'hubspot context fetched' }));
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'hubspot context unavailable; continuing', err: String(err) }));
    }
    // Platform caller memory (facts + preferences extracted from past calls).
    if (process.env.MEMORY_ID && event.tenantId) {
      try {
        const memories = await callerMemoryRecall(event.tenantId, lead.phone);
        if (memories.length) crmContext += `\n\nPlatform memory about this caller:\n${memories.map((m) => `- ${m}`).join('\n')}`;
        console.log(JSON.stringify({ msg: 'caller memory recalled', records: memories.length }));
      } catch (err) {
        console.warn(JSON.stringify({ msg: 'caller memory unavailable; continuing', err: String(err) }));
      }
    }
  }

  const draft = await draftEmail(lead, crmContext);
  const googleToken = await googleAccessToken();
  const sentTo = await sendAsOwner(googleToken, draft.subject, draft.body);
  console.log(JSON.stringify({ msg: 'email sent', sentTo, subject: draft.subject }));
  const tenantId = event.tenantId ?? 'wnk';
  await recordUsage(tenantId, 'emails_sent', 1, event.callId);
  if (draftTokens > 0) await recordUsage(tenantId, 'llm_tokens', draftTokens, event.callId);
  return { ok: true, sentTo, subject: draft.subject };
}

// AgentCore Runtime HTTP contract, hand-rolled (single-file bundle, no deps):
// GET /ping -> {"status":"Healthy"}; POST /invocations (JSON payload) -> JSON.
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
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as LeadEvent;
          const result = await processLead(payload);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(JSON.stringify({ msg: 'invocation failed', err: String(err) }));
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      })();
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(8080, '0.0.0.0', () => console.log(JSON.stringify({ msg: 'email responder listening', port: 8080 })));
