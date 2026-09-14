/**
 * Composio health canary: on a schedule, prove every tenant's Composio
 * connections are still ACTIVE before a caller finds out they are not.
 *
 * A revoked or expired connection fails nothing on its own: every CRM and
 * Gmail state catches and carries on, so the receptionist quietly stops
 * recognizing callers and the owner's emails lose their CRM section. This
 * turns that silence into a failed execution, which alarms.
 *
 * What each tenant row promises, read from its own flags:
 *   crm.via = composio                 -> an ACTIVE hubspot account
 *   products.emailResponder.enabled    -> an ACTIVE gmail account
 *   products.assistant.enabled         -> at least one ACTIVE account (its session binds them)
 * A new toolkit is one more line in `expectedToolkitsExpr`. A new tenant is
 * covered by the scan; nothing here names one.
 */
import { composio, hasCrm, q } from './asl.js';

export interface ComposioHealthRefs {
  tenantsTable: string;
  composioConnectionArn: string;
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/** Toolkit slugs a tenant row (DynamoDB AttributeValue shape) must have ACTIVE in Composio. */
export const expectedToolkitsExpr = (rowExpr: string) => [
  '$append(',
  `(${hasCrm(rowExpr)} ? ['hubspot'] : []),`,
  `(${rowExpr}.products.M.emailResponder.M.enabled.BOOL = true ? ['gmail'] : [])`,
  ')',
].join(' ');

/** Of `expectedExpr` (slugs), those not in `activeExpr` (slugs Composio reports ACTIVE). */
export const missingToolkitsExpr = (expectedExpr: string, activeExpr: string) => `[$filter(${expectedExpr}, function($t) { $not($t in ${activeExpr}) })]`;

// ---- Definition ----------------------------------------------------------------

export function composioHealthDefinition(refs: ComposioHealthRefs) {
  return {
    QueryLanguage: 'JSONata',
    StartAt: 'ListTenants',
    States: {
      // The Tenants table is tiny (one row per called number); a scan is the read.
      ListTenants: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:dynamodb:scan',
        Arguments: { TableName: refs.tenantsTable },
        Assign: { tenants: q('[$states.result.Items]') },
        Output: q('$states.input'), Next: 'EachTenant',
      },
      EachTenant: {
        Type: 'Map',
        Items: q('$tenants'),
        MaxConcurrency: 2,
        ItemProcessor: {
          ProcessorConfig: { Mode: 'INLINE' },
          StartAt: 'Expect',
          States: {
            Expect: {
              Type: 'Pass',
              Assign: {
                tenantId: q('$states.input.tenantId.S'),
                expected: q(expectedToolkitsExpr('$states.input')),
                needsAny: q('$states.input.products.M.assistant.M.enabled.BOOL = true'),
              },
              Output: q('$states.input'), Next: 'UsesComposio',
            },
            UsesComposio: { Type: 'Choice', Choices: [{ Condition: q('$count($expected) > 0 or $needsAny'), Next: 'ActiveAccounts' }], Default: 'NotUsed' },
            NotUsed: { Type: 'Succeed' },
            ActiveAccounts: {
              ...composio(refs.composioConnectionArn, q('$tenantId')).accounts(),
              Assign: { active: q('[$states.result.ResponseBody.items.toolkit.slug]') },
              Output: q('$states.input'), Next: 'AllPresent',
            },
            AllPresent: {
              Type: 'Choice',
              Choices: [{ Condition: q(`$count(${missingToolkitsExpr('$expected', '$active')}) = 0 and ($needsAny ? $count($active) > 0 : true)`), Next: 'Healthy' }],
              Default: 'Unhealthy',
            },
            Healthy: { Type: 'Succeed' },
            Unhealthy: {
              Type: 'Fail', Error: 'ComposioConnectionMissing',
              Cause: q(`'tenant ' & $tenantId & ': ' & ($count(${missingToolkitsExpr('$expected', '$active')}) > 0 ? 'no ACTIVE Composio account for ' & $join(${missingToolkitsExpr('$expected', '$active')}, ', ') : 'assistant is on but no ACTIVE Composio account at all') & '. Reconnect: npx tsx scripts/connect-composio.mts ' & $tenantId & ' <toolkit>'`),
            },
          },
        },
        End: true,
      },
    },
  };
}
