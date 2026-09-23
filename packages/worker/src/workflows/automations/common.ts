/** What the tenant automations share: the outcome type, and the HubSpot bits two of them repeat. */
import { ApplicationFailure } from '@temporalio/workflow';

export type AutomationOutcome = 'skipped' | 'done';

/** A HubSpot contact search by either phone property. */
export const phoneFilters = (phone: string) => [
  { filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] },
  { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: phone }] },
];

/** Composio answered; a `successful: false` fails the workflow, naming the step. */
export const ok = (r: { successful?: boolean; error?: unknown }, what: string) => {
  if (r.successful !== true) throw ApplicationFailure.nonRetryable(`${what}: Composio answered successful=false: ${String(r.error ?? '')}`.slice(0, 500), 'ComposioRejected');
};
