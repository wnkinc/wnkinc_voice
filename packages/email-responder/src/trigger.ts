/**
 * EventBridge -> Runtime glue: a `lead.recorded` event invokes the email
 * responder agent with the event detail as its payload.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { EventBridgeEvent } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const client = new BedrockAgentCoreClient({});

export async function handler(event: EventBridgeEvent<string, Record<string, unknown>>): Promise<void> {
  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: process.env.EMAIL_AGENT_RUNTIME_ARN,
    qualifier: 'DEFAULT',
    runtimeSessionId: `lead-${randomUUID()}-${randomUUID()}`, // session ids must be >= 33 chars
    contentType: 'application/json',
    accept: 'application/json',
    payload: Buffer.from(JSON.stringify(event.detail)),
  }));
  const body = res.response ? Buffer.from(await res.response.transformToByteArray()).toString('utf8') : '';
  console.log(JSON.stringify({ msg: 'agent invoked', status: res.statusCode, body: body.slice(0, 500) }));
}
