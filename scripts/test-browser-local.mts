import { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';

const REGION = 'us-west-2';
const browserId = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', 'wnk-runtime-dev', '--query', "Stacks[0].Outputs[?OutputKey=='browserId'].OutputValue | [0]", '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();
const client = new BedrockAgentCoreClient({ region: REGION });
const session = await client.send(new StartBrowserSessionCommand({ browserIdentifier: browserId, sessionTimeoutSeconds: 120 }));
const endpoint = session.streams!.automationStream!.streamEndpoint!;
console.log('endpoint:', endpoint);
const url = new URL(endpoint);
const signer = new SignatureV4({ credentials: defaultProvider(), region: REGION, service: 'bedrock-agentcore', sha256: Sha256 });
const signed = await signer.sign(new HttpRequest({ method: 'GET', protocol: 'https:', hostname: url.hostname, path: url.pathname, headers: { host: url.hostname } }));
await new Promise<void>((resolve) => {
  const ws = new WebSocket(endpoint, { headers: signed.headers as Record<string, string>, handshakeTimeout: 15000 });
  ws.once('open', () => { console.log('WS OPEN — signing works'); ws.close(); resolve(); });
  ws.once('unexpected-response', (_req, res) => { console.log('WS REJECTED', res.statusCode, JSON.stringify(res.headers)); resolve(); });
  ws.once('error', (e) => { console.log('WS ERROR', String(e)); resolve(); });
});
await client.send(new StopBrowserSessionCommand({ browserIdentifier: browserId, sessionId: session.sessionId! })).catch(() => {});
