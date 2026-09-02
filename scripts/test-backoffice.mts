/**
 * Phase-6 proof: hand the back-office agent a research task.
 *
 *   npx tsx scripts/test-backoffice.mts "question" "https://url" [tenantId]
 *
 * The tenant must have products.backOffice.enabled — the agent refuses otherwise.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const question = process.argv[2] ?? 'What is the population of Spokane, Washington?';
const url = process.argv[3] ?? 'https://en.wikipedia.org/wiki/Spokane,_Washington';
const tenantId = process.argv[4] ?? 'wnk';

const arn = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', 'wnk-runtime-dev', '--query', "Stacks[0].Outputs[?OutputKey=='backOfficeRuntimeArn'].OutputValue | [0]", '--output', 'text', '--region', 'us-west-2'], { encoding: 'utf8' }).trim();
const client = new BedrockAgentCoreClient({ region: 'us-west-2' });
console.log(`task: ${question}\nurl:  ${url}\ntenant: ${tenantId}`);
const res = await client.send(new InvokeAgentRuntimeCommand({
  agentRuntimeArn: arn,
  qualifier: 'DEFAULT',
  runtimeSessionId: `task-${randomUUID()}-${randomUUID()}`,
  contentType: 'application/json',
  accept: 'application/json',
  payload: Buffer.from(JSON.stringify({ question, url, tenantId })),
}));
const body = res.response ? Buffer.from(await res.response.transformToByteArray()).toString('utf8') : '';
console.log(JSON.stringify(JSON.parse(body), null, 2));
