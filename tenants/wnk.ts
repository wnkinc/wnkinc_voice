/**
 * What the wnk tenant runs on the bus. Stock automations from the library,
 * each deployed as this tenant's own machine (stack wnk-tenant-wnk-dev). A
 * variation for this tenant goes here: a descriptor with options, or a copied
 * definition, never a Choice inside a shared one.
 */
import type { TenantAutomations } from '../packages/infrastructure/stacks/tenant-stack.js';
import { crmCall } from '../packages/infrastructure/workflows/crm-call.js';
import { crmLead } from '../packages/infrastructure/workflows/crm-lead.js';
import { leadEmail } from '../packages/infrastructure/workflows/lead-email.js';
import { ownerAlert } from '../packages/infrastructure/workflows/owner-alert.js';

export const wnk: TenantAutomations = {
  tenantId: 'wnk',
  automations: [leadEmail, crmLead, crmCall, ownerAlert],
};
