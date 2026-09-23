/** The tenant registry: each tenant gets the stacks its file asks for. One line per tenant. */
import type { TenantAutomations } from '@wnk/shared/contracts';
import { meg } from './meg.js';
import { wnk } from './wnk.js';

export const tenants: readonly TenantAutomations[] = [wnk, meg];
