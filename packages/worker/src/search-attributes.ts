/**
 * The search attributes the platform sets on its workflows, so an operator
 * can list every workflow of one tenant (`TenantId="deck"` in the UI or the
 * CLI). A custom attribute must exist in the namespace before a start names
 * it: a person creates what is listed here once per namespace (ops/README.md),
 * and scripts/temporal-namespace.mts checks before a deploy and at every release.
 */
import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

/** The tenant a workflow acts for: on every automation at start, on a turn once the sender's tenant is known. */
export const TENANT_ID = defineSearchAttributeKey('TenantId', SearchAttributeType.KEYWORD);

/** Every custom attribute the platform sets. */
export const SEARCH_ATTRIBUTES = [TENANT_ID] as const;
