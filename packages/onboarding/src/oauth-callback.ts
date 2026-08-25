/**
 * 3LO session-binding callback (AgentCore Identity). After a user consents at
 * Google, AgentCore redirects their browser here with ?session_id=...; calling
 * CompleteResourceTokenAuth binds the session to the user and lets the vault
 * store the token.
 *
 * DEV SHORTCUT: the user id arrives via the OAuth `state` parameter that our
 * connect script set. A real onboarding app must instead read the logged-in
 * user from its own session (cookie), or the binding protects nothing.
 */
import { BedrockAgentCoreClient, CompleteResourceTokenAuthCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new BedrockAgentCoreClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const sessionId = event.queryStringParameters?.session_id;
  const userId = event.queryStringParameters?.state;
  if (!sessionId || !userId) {
    return { statusCode: 400, body: 'missing session_id or state' };
  }
  await client.send(new CompleteResourceTokenAuthCommand({
    sessionUri: sessionId,
    userIdentifier: { userId },
  }));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    body: '<h2>Connected.</h2><p>You can close this tab and return to your agent.</p>',
  };
}
