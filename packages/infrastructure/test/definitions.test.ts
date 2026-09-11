/**
 * Every Step Functions definition the app synthesizes, checked by the service
 * before a deploy: JSONata syntax, state references, field names. Covers new
 * workflows automatically. Needs AWS credentials (one read-only API call per
 * definition, no resources touched); skips with a warning without them.
 */
import { SFNClient, ValidateStateMachineDefinitionCommand, type ValidateStateMachineDefinitionDiagnostic } from '@aws-sdk/client-sfn';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'cdk.out');

interface Definition { stack: string; id: string; type: 'STANDARD' | 'EXPRESS'; text: string }

/**
 * Stand-ins for deploy-time tokens (Ref, GetAtt, ImportValue), by the field
 * they land in: the validator checks ARN shapes, so a Connection or harness
 * reference must look like one. Other fields accept any string.
 */
const PLACEHOLDERS: Record<string, string> = {
  ConnectionArn: 'arn:aws:events:us-west-2:123456789012:connection/placeholder/00000000-0000-0000-0000-000000000000',
  HarnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/placeholder',
  'x-api-key': 'arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/placeholder',
};

/** Flatten a template's DefinitionString: literal parts as-is, deploy-time tokens as the placeholder for their field. */
function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!(value && typeof value === 'object' && 'Fn::Join' in value)) return 'placeholder';
  const [sep, parts] = (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
  let text = '';
  for (const [i, part] of parts.entries()) {
    if (i > 0) text += sep;
    if (typeof part === 'string') { text += part; continue; }
    const field = /"([A-Za-z-]+)":"[^"]*$/.exec(text)?.[1] ?? '';
    text += PLACEHOLDERS[field] ?? 'placeholder';
  }
  return text;
}

function synthesizedDefinitions(): Definition[] {
  execSync('npx cdk synth --quiet', { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { artifacts: Record<string, { type: string; properties?: { templateFile?: string } }> };
  const defs: Definition[] = [];
  for (const [stack, artifact] of Object.entries(manifest.artifacts)) {
    if (artifact.type !== 'aws:cloudformation:stack' || !artifact.properties?.templateFile) continue;
    const template = JSON.parse(readFileSync(path.join(out, artifact.properties.templateFile), 'utf8')) as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    for (const [id, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== 'AWS::StepFunctions::StateMachine') continue;
      defs.push({ stack, id, type: (resource.Properties.StateMachineType as 'EXPRESS' | undefined) ?? 'STANDARD', text: flatten(resource.Properties.DefinitionString) });
    }
  }
  return defs;
}

async function hasCredentials(client: SFNClient): Promise<boolean> {
  try { await client.config.credentials(); return true; } catch { return false; }
}

const format = (d: ValidateStateMachineDefinitionDiagnostic) => `${d.severity} ${d.code} at ${d.location ?? '?'}: ${d.message}`;

describe('synthesized state machine definitions', () => {
  const client = new SFNClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
  let defs: Definition[] = [];
  let credentials = false;

  beforeAll(async () => {
    defs = synthesizedDefinitions();
    credentials = await hasCredentials(client);
    if (!credentials) console.warn('No AWS credentials: definitions synthesized but not validated');
  }, 120_000);

  it('synthesizes every workflow', () => {
    expect(defs.map((d) => d.id).sort()).toEqual([
      'AcceptWorkflow842BBA18', 'CallEndedWorkflow7253F29B', 'CrmCallWorkflowD095AD4A', 'CrmLeadWorkflow3E31F026',
      'LeadEmailWorkflowE6E42485', 'OwnerAlertWorkflowD38F6F45', 'TelegramWorkflow48A0C9CE',
    ]);
  });

  it('every definition is valid Step Functions (JSONata parsed, states resolve)', async () => {
    if (!credentials) return;
    const failures: string[] = [];
    for (const def of defs) {
      const res = await client.send(new ValidateStateMachineDefinitionCommand({ definition: def.text, type: def.type, severity: 'WARNING', maxResults: 50 }));
      const errors = (res.diagnostics ?? []).filter((d) => d.severity === 'ERROR');
      const warnings = (res.diagnostics ?? []).filter((d) => d.severity === 'WARNING');
      for (const w of warnings) console.warn(`${def.stack}/${def.id}: ${format(w)}`);
      if (res.result !== 'OK' || errors.length) failures.push(`${def.stack}/${def.id}:\n  ${errors.map(format).join('\n  ')}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);
});
