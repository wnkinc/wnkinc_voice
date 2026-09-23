/**
 * Composio for one tenant, as activities: the shared HTTP client
 * (@wnk/shared/composio-api) with the tenant id the workflow passes from the
 * row it resolved, never something the model or a caller names. `version`
 * pins the toolkit release; without it the REST API runs the toolkit's oldest.
 */
import type { ComposioAccount, ComposioResult } from '@wnk/shared/composio-api';
import { composio } from './clients.js';

export type { ComposioAccount, ComposioResult };

export const executeTool = (tenantId: string, slug: string, args: Record<string, unknown>, version?: string): Promise<ComposioResult> =>
  composio.executeTool(tenantId, slug, args, { version });

/** The tenant's ACTIVE connected accounts, for one toolkit or all. */
export const composioAccounts = (tenantId: string, toolkit?: string): Promise<ComposioAccount[]> => composio.accounts(tenantId, { toolkit });

/** The toolkit's own REST API on one of the tenant's accounts (`accountId` from composioAccounts), for what no tool covers. */
export const composioProxy = (tenantId: string, accountId: string, method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>): Promise<ComposioResult> =>
  composio.proxy(tenantId, accountId, method, endpoint, body);
