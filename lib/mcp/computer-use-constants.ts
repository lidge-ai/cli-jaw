/**
 * lib/mcp/computer-use-constants.ts
 * Names shared by the jaw-computer-use proxy, its managed MCP entry and the
 * spawn path that hands each run's approval policy to the proxy.
 */

/** Unified MCP server name for the jaw-owned Computer Use proxy. */
export const COMPUTER_USE_MCP_NAME = 'jaw-computer-use';

/** Run-bound approval policy for Computer Use app approvals: exactly 'auto' approves. */
export const COMPUTER_USE_APPROVAL_ENV = 'JAW_COMPUTER_USE_APPROVAL';

/** Compiled entry file the managed MCP entry points at (dist/lib/mcp/...). */
export const PROXY_ENTRY_BASENAME = 'computer-use-proxy-main.js';
