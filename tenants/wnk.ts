/**
 * What the wnk tenant runs on the bus: stock automations from the worker's
 * catalog, each a rule in this tenant's stack (wnk-tenant-wnk-dev) that
 * starts the workflow for this tenant's events alone. A variation for this
 * tenant is an option on the entry, never a conditional in the shared
 * workflow.
 */
import type { TenantAutomations } from '@wnk/shared/contracts';

export const wnk: TenantAutomations = {
  tenantId: 'wnk',
  automations: [{ workflow: 'leadEmail' }, { workflow: 'crmLead' }, { workflow: 'crmCall' }, { workflow: 'ownerAlert' }],
};
