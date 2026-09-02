/**
 * EventBridge -> Runtime glue: a `lead.recorded` event invokes the email
 * responder agent with the event detail as its payload.
 *
 * Two jobs beyond the invoke: carry the trace across (W3C traceparent from
 * the X-Ray header, plus baggage naming the tenant and call so the agent's
 * logs can be joined to the call's), and FAIL LOUDLY — a non-2xx from the
 * agent throws, so Lambda's async retries run and the dead-letter queue and
 * its alarm catch what still fails. Swallowing the status here is how a lost
 * email stays silent.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { currentXrayHeader, encodeBaggage, xrayToTraceparent } from '@wnk/shared';
import type { EventBridgeEvent } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const client = new BedrockAgentCoreClient({});

export async function handler(event: EventBridgeEvent<string, { tenantId?: string; callId?: string }>): Promise<void> {
  const xray = currentXrayHeader();
  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: process.env.EMAIL_AGENT_RUNTIME_ARN,
    qualifier: 'DEFAULT',
    runtimeSessionId: `lead-${randomUUID()}-${randomUUID()}`, // session ids must be >= 33 chars
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(JSON.stringify(event.detail)),
    traceParent: xray ? xrayToTraceparent(xray) : undefined,
    baggage: encodeBaggage({ tenant_id: event.detail.tenantId, call_id: event.detail.callId }),
  }));
  const body = res.response ? Buffer.from(await res.response.transformToByteArray()).toString('utf8') : '';
  console.log(JSON.stringify({ msg: 'agent invoked', status: res.statusCode, tenantId: event.detail.tenantId, callId: event.detail.callId, body: body.slice(0, 500) }));
  if ((res.statusCode ?? 200) >= 300) throw new Error(`email agent returned ${res.statusCode}: ${body.slice(0, 300)}`);
}
