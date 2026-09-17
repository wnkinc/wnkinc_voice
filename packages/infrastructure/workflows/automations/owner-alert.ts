/**
 * Owner alert: owner.notify -> this workflow -> the Telegram reply path.
 *
 * The receptionist's notify_owner tool publishes owner.notify. This reads
 * the tenant row, picks the owner with a Telegram id, and publishes the same
 * telegram.reply event the assistant uses; the runtime stack's reply rule
 * delivers it. No once-marker: an alert delivered twice on a rare redelivery
 * is harmless, and it is neither money nor customer-facing. A tenant with
 * the tool on but no owner channel fails loudly (alarm).
 */
import { q } from '../asl.js';
import type { Automation } from './automation.js';

export interface OwnerAlertRefs {
  tenantsTable: string;
  busName: string;
}

export function ownerAlertDefinition(refs: OwnerAlertRefs) {
  return {
    QueryLanguage: 'JSONata',
    StartAt: 'LookupTenant',
    States: {
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$states.input.detail.tenantPhoneNumber') } } },
        Assign: {
          tenant: q('$states.result.Item'),
          chatId: q("$states.result.Item.people.L[M.role.S = 'owner' and $exists(M.telegramId.N)][0].M.telegramId.N"),
        },
        Output: q('$states.input'), Next: 'OwnerChannel',
      },
      OwnerChannel: { Type: 'Choice', Choices: [{ Condition: q('$exists($chatId)'), Next: 'Deliver' }], Default: 'NoOwnerChannel' },
      NoOwnerChannel: { Type: 'Fail', Error: 'NoOwnerChannel', Cause: 'The tenant has no owner with a Telegram id; add one under people and re-seed' },
      Deliver: {
        Type: 'Task', Resource: 'arn:aws:states:::events:putEvents',
        Arguments: { Entries: [{
          EventBusName: refs.busName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
          Detail: q([
            "$string({'tenantId': $tenant.tenantId.S, 'chatId': $number($chatId), 'text': ",
            "($states.input.detail.urgency = 'urgent' ? 'URGENT' : 'Heads up') & ' (' & $tenant.business.M.name.S & '): ' & $states.input.detail.summary",
            " & ($exists($states.input.detail.callerPhone) ? ' Caller: ' & $states.input.detail.callerPhone : '')})",
          ].join('')),
        }] },
        End: true,
      },
    },
  };
}

/** The stock owner alert, as a tenant automation. */
export const ownerAlert: Automation = {
  name: 'owner-alert', on: 'owner.notify', timeoutMinutes: 2,
  needs: { tenants: true, bus: true },
  definition: ownerAlertDefinition,
};
