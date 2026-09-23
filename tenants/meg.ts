/**
 * meg is not on the voice platform: no number, no row, no automations. The
 * tenant's own Telegram account is served as an MCP server for their ChatGPT
 * (stack wnk-dev-telegram-mcp-meg; onboarding in packages/telegram-mcp/README.md).
 */
import type { TenantAutomations } from '@wnk/shared/contracts';

export const meg: TenantAutomations = {
  tenantId: 'meg',
  automations: [],
  telegramMcp: true,
};
