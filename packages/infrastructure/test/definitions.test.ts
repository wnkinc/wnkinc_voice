/**
 * Every Step Functions definition the app synthesizes, checked two ways:
 * the platform invariants (locally, so copy-paste between workflow files is
 * safe), then the service validator (JSONata syntax, state references, field
 * names) before a deploy. Covers new workflows automatically. The validator
 * needs AWS credentials (one read-only API call per definition, no resources
 * touched) and skips with a warning without them; the invariants always run.
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
interface Rule { stack: string; id: string; pattern: Record<string, unknown> | undefined }

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

/** Every state machine and every EventBridge rule the app synthesizes, by stack. */
function synthesized(): { defs: Definition[]; rules: Rule[] } {
  execSync('npx cdk synth --quiet', { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { artifacts: Record<string, { type: string; properties?: { templateFile?: string } }> };
  const defs: Definition[] = [];
  const rules: Rule[] = [];
  for (const [stack, artifact] of Object.entries(manifest.artifacts)) {
    if (artifact.type !== 'aws:cloudformation:stack' || !artifact.properties?.templateFile) continue;
    const template = JSON.parse(readFileSync(path.join(out, artifact.properties.templateFile), 'utf8')) as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    for (const [id, resource] of Object.entries(template.Resources)) {
      if (resource.Type === 'AWS::StepFunctions::StateMachine') {
        defs.push({ stack, id, type: (resource.Properties.StateMachineType as 'EXPRESS' | undefined) ?? 'STANDARD', text: flatten(resource.Properties.DefinitionString) });
      } else if (resource.Type === 'AWS::Events::Rule') {
        rules.push({ stack, id, pattern: resource.Properties.EventPattern as Record<string, unknown> | undefined });
      }
    }
  }
  return { defs, rules };
}

// ---- Walking a definition ----------------------------------------------------

type State = Record<string, any>;

/** Every state in a definition, including those nested in Map and Parallel, as [path, state]. */
function allStates(def: { States: Record<string, State> }, prefix = ''): [string, State][] {
  const out: [string, State][] = [];
  for (const [name, state] of Object.entries(def.States ?? {})) {
    const path = `${prefix}${name}`;
    out.push([path, state]);
    if (state.ItemProcessor?.States) out.push(...allStates(state.ItemProcessor, `${path}/`));
    for (const [i, branch] of (state.Branches ?? []).entries()) out.push(...allStates(branch, `${path}/${i}/`));
  }
  return out;
}

const isHttp = (s: State) => s.Type === 'Task' && s.Resource === 'arn:aws:states:::http:invoke';
const isComposio = (s: State) => isHttp(s) && String(s.Arguments?.ApiEndpoint ?? '').startsWith('https://backend.composio.dev/');
/**
 * A side effect that costs money or reaches a customer irreversibly (CLAUDE.md:
 * those need a once-marker). A CRM note or a memory event is neither: a
 * duplicate is clutter. That is why the assistant may add notes and write its
 * turn to memory on a person's say-so without a marker, and why sending email
 * is not yet one of its tools. (call-ended keeps its marker for the minutes
 * it meters, not for the memory write.)
 */
const isCostly = (s: State) =>
  isComposio(s) && /tools\/execute\/(GMAIL_SEND_EMAIL|HUBSPOT_(CREATE|UPDATE)_(CONTACT|TASK))/.test(String(s.Arguments.ApiEndpoint));
const isOnceMarker = (s: State, resource: string) =>
  s.Resource === `arn:aws:states:::dynamodb:${resource}` && String(s.Arguments?.ExpressionAttributeNames?.['#k'] ?? '').includes('done:');

async function hasCredentials(client: SFNClient): Promise<boolean> {
  try { await client.config.credentials(); return true; } catch { return false; }
}

const format = (d: ValidateStateMachineDefinitionDiagnostic) => `${d.severity} ${d.code} at ${d.location ?? '?'}: ${d.message}`;

describe('synthesized state machine definitions', () => {
  const client = new SFNClient({ region: process.env.AWS_REGION ?? 'us-west-2' });
  let defs: Definition[] = [];
  let rules: Rule[] = [];
  let credentials = false;

  beforeAll(async () => {
    ({ defs, rules } = synthesized());
    credentials = await hasCredentials(client);
    if (!credentials) console.warn('No AWS credentials: definitions synthesized but not validated');
  }, 120_000);

  it('synthesizes every workflow, platform ones in the platform stacks and tenant ones in the tenant stack', () => {
    expect(defs.map((d) => `${d.stack}/${d.id.replace(/[0-9A-F]{8}$/, '')}`).sort()).toEqual([
      'wnk-runtime-dev/AssistantHealthWorkflow', 'wnk-runtime-dev/BrowserLoginWorkflow', 'wnk-runtime-dev/CallEndedWorkflow', 'wnk-runtime-dev/ComposioHealthWorkflow', 'wnk-runtime-dev/SmsWorkflow', 'wnk-runtime-dev/TelegramWorkflow',
      'wnk-tenant-wnk-dev/CrmCallWorkflow', 'wnk-tenant-wnk-dev/CrmLeadWorkflow', 'wnk-tenant-wnk-dev/LeadEmailWorkflow', 'wnk-tenant-wnk-dev/OwnerAlertWorkflow',
      'wnk-voice-dev/AcceptWorkflow',
    ]);
  });

  // The tenancy guarantee of a tenant stack: nothing in it can start on
  // another tenant's event. Every rule's pattern names the stack's tenant.
  it('every rule in a tenant stack matches only that tenant\'s events', () => {
    const tenantOf = (stack: string) => /^wnk-tenant-(.+)-dev$/.exec(stack)?.[1];
    const tenantRules = rules.filter((r) => tenantOf(r.stack));
    expect(tenantRules.length).toBeGreaterThan(0);
    const failures = tenantRules
      .filter((r) => JSON.stringify((r.pattern?.detail as Record<string, unknown> | undefined)?.tenantId) !== JSON.stringify([tenantOf(r.stack)]))
      .map((r) => `${r.stack}/${r.id}: ${JSON.stringify(r.pattern)}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // ---- Invariants: the rules every workflow must meet, checked locally so
  // copy-paste between workflow files is safe. Add a rule here, not a helper.
  describe('invariants', () => {
    const each = (check: (id: string, states: [string, State][]) => string[]) => {
      const failures = defs.flatMap((d) => check(`${d.stack}/${d.id}`, allStates(JSON.parse(d.text))).map((f) => `${d.stack}/${d.id}: ${f}`));
      expect(failures, failures.join('\n')).toEqual([]);
    };

    it('every Next, Default, and Catch names a state in its scope', () => each((_, states) => {
      const failures: string[] = [];
      for (const [path, state] of states) {
        const scope = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const names = new Set(states.filter(([p]) => p.startsWith(scope) && !p.slice(scope.length).includes('/')).map(([p]) => p.slice(scope.length)));
        const refs = [state.Next, state.Default, ...(state.Choices ?? []).map((c: State) => c.Next), ...(state.Catch ?? []).map((c: State) => c.Next)].filter(Boolean);
        for (const ref of refs) if (!names.has(ref)) failures.push(`${path} -> ${ref} does not exist`);
      }
      return failures;
    }));

    it('every HTTP task retries, unless it is budgeted (TimeoutSeconds: a lookup on the ringing path)', () => each((_, states) =>
      states.filter(([, s]) => isHttp(s) && !(s.Retry?.length > 0) && !s.TimeoutSeconds).map(([p]) => `${p} has no Retry and no TimeoutSeconds`)));

    it('every Composio call names the tenant (user_id, user_ids, or an account resolved from it)', () => each((_, states) =>
      states.filter(([, s]) => isComposio(s)).filter(([, s]) => {
        const body = typeof s.Arguments.RequestBody === 'object' ? s.Arguments.RequestBody : {};
        return !(body.user_id || body.connected_account_id || s.Arguments.QueryParameters?.user_ids);
      }).map(([p]) => `${p} does not name the tenant`)));

    // The two DynamoDB integrations disagree on the spelling of the all-caps
    // AttributeValue tags: the optimized `dynamodb:getItem` answers with the
    // API's `BOOL`/`NULL`, the generic `aws-sdk:dynamodb:*` with the SDK's
    // `Bool`/`Null`. Reading the wrong one is not an error — it is `undefined`,
    // so the condition is quietly false and the branch silently never taken.
    // That shipped once: composio-health stopped checking Gmail at all.
    it('reads booleans in the casing its DynamoDB integration returns', () => {
      const failures: string[] = [];
      for (const d of defs) {
        const sdk = /aws-sdk:dynamodb/.test(d.text);
        const optimized = /arn:aws:states:::dynamodb:/.test(d.text);
        if (sdk === optimized) continue; // none, or both: nothing to infer
        const wrong = sdk ? /\.(BOOL|NULL)\b/g : /\.(Bool|Null)\b/g;
        const right = sdk ? 'Bool/Null' : 'BOOL/NULL';
        for (const m of d.text.match(wrong) ?? []) {
          failures.push(`${d.stack}/${d.id}: reads ${m} but its ${sdk ? 'aws-sdk' : 'optimized'} integration returns ${right}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });

    it('every workflow with a costly side effect checks and writes a once-marker', () => each((_, states) => {
      if (!states.some(([, s]) => isCostly(s))) return [];
      const failures: string[] = [];
      if (!states.some(([, s]) => isOnceMarker(s, 'getItem'))) failures.push('no once-marker read (checkDone) before the side effect');
      if (!states.some(([, s]) => isOnceMarker(s, 'updateItem'))) failures.push('no once-marker write (markDone) after the side effect');
      return failures;
    }));
  });

  // The isolation proof for a shared source file: every machine's synthesized
  // definition is a file in git. An edit to a stock definition shows up here
  // as a diff on every tenant machine it changes, before any deploy. The diff
  // must list only the tenants meant to change; then `npm run test:update`
  // records the new definitions in the same commit. Deploy-time tokens are
  // placeholders, so the files are stable across accounts.
  it('every machine matches its snapshot: a change must touch only the tenants it was meant for', async () => {
    for (const d of defs) {
      const pretty = `${JSON.stringify(JSON.parse(d.text), null, 2)}\n`;
      await expect(pretty).toMatchFileSnapshot(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', `${d.stack}.${d.id.replace(/[0-9A-F]{8}$/, '')}.json`));
    }
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
