/** The tenant registry: every tenant with automations gets a stack. One line per tenant. */
import type { TenantAutomations } from '../packages/infrastructure/stacks/tenant-stack.js';
import { wnk } from './wnk.js';

export const tenants: readonly TenantAutomations[] = [wnk];
