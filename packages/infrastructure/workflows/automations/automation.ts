/**
 * A tenant automation: the bus event that starts it, its definition, and what
 * the machine needs granted. Each workflow file exports one; a tenant file
 * (tenants/<id>.ts) lists the ones that tenant gets, and the tenant stack
 * deploys each as a state machine whose rule matches that tenant's events
 * alone. A variant is another descriptor: the same definition with options,
 * or a copied one. No CDK imports here, so a test can import and walk these.
 */

/** Platform names every definition may take; each definition declares the subset it reads. */
export interface AutomationRefs {
  tenantsTable: string;
  callsTable: string;
  usageTable: string;
  composioConnectionArn: string;
  busName: string;
  /** Caller memory; omitted when the platform has none, and definitions then emit no memory states. */
  memoryId?: string;
}

export interface Automation {
  /** Machine name suffix: `<prefix>-<tenantId>-<name>`. Also the output key (`leadEmailWorkflowArn`). */
  name: string;
  /** The wnkinc.voice detail-type that starts it, filtered by the tenant id in the rule. */
  on: 'lead.recorded' | 'call.ended' | 'owner.notify';
  /** Express with execution data not logged: for definitions that handle transcripts or CRM notes. Default Standard. */
  express?: boolean;
  timeoutMinutes: number;
  /**
   * What the machine's role is granted. Fixed per key: tenants is read,
   * calls is read+write (once-markers), usage is write, composio is the
   * HTTP task through the platform Connection, memory is the memory-use
   * actions, bus is putEvents.
   */
  needs: { tenants?: boolean; calls?: boolean; usage?: boolean; composio?: boolean; memory?: boolean; bus?: boolean };
  definition: (refs: AutomationRefs) => object;
}
