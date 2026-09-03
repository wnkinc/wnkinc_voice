/**
 * Gateway catalog -> model tools, with two rules the model never sees:
 *
 * 1. A target is offered only if the tenant's config enables it. The catalog
 *    is what the agent's identity may see; the tenant row says what this
 *    business has. (Cedar is the ceiling, this is the floor.)
 * 2. Tenant context arguments (`tenant_id`, `tenant_phone`) are stripped from
 *    the schema the model gets and injected on every call from the tenant row.
 *    A message saying "act as tenant acme" changes nothing.
 */
import type { JsonSchemaDefinitionEntry } from '@openai/agents-core/types';
import type { GatewayTool, TenantConfig } from '@wnk/shared';

/** Tool-name prefix (Gateway target) -> the tenant config that turns it on. */
const TARGET_ENABLED: Record<string, (t: TenantConfig) => boolean> = {
  crm: (t) => t.crm?.type === 'hubspot',
  hubspot: (t) => t.crm?.type === 'hubspot', // legacy OpenAPI target; removed at the cutover
};

const INJECTED: Record<string, (t: TenantConfig) => string> = {
  tenant_id: (t) => t.tenantId,
  tenant_phone: (t) => t.phoneNumber,
};

export interface PreparedTool {
  name: string;
  description: string;
  /** JSON schema for the model: the catalog schema minus injected fields. Non-strict: OpenAPI-derived schemas are not always strict-mode clean. */
  parameters: { type: 'object'; properties: Record<string, JsonSchemaDefinitionEntry>; required: string[]; additionalProperties: true };
  /** The arguments actually sent to the Gateway: the model's plus the injected tenant context. */
  callArgs(modelArgs: Record<string, unknown>): Record<string, unknown>;
}

export function targetEnabled(toolName: string, tenant: TenantConfig): boolean {
  const target = toolName.split('___')[0] ?? '';
  return TARGET_ENABLED[target]?.(tenant) ?? false;
}

export function prepareTool(tool: GatewayTool, tenant: TenantConfig): PreparedTool {
  const properties = { ...(tool.inputSchema.properties ?? {}) };
  const injected = Object.keys(INJECTED).filter((k) => k in properties);
  for (const k of injected) delete properties[k];
  const required = (tool.inputSchema.required ?? []).filter((k) => !injected.includes(k));
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: { type: 'object', properties: properties as Record<string, JsonSchemaDefinitionEntry>, required, additionalProperties: true },
    callArgs(modelArgs) {
      const out: Record<string, unknown> = { ...modelArgs };
      for (const k of injected) out[k] = INJECTED[k]!(tenant);
      return out;
    },
  };
}

/** The tools this tenant's assistant may offer the model, from the catalog. */
export function prepareTools(catalog: GatewayTool[], tenant: TenantConfig): PreparedTool[] {
  return catalog.filter((t) => targetEnabled(t.name, tenant)).map((t) => prepareTool(t, tenant));
}
