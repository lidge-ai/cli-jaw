/**
 * lib/mcp-sync.ts — Re-export facade
 * Backward-compatible barrel that re-exports all public API from lib/mcp/ modules.
 * Source of truth: ~/.cli-jaw/mcp.json
 *
 * Supported targets (all global):
 *   Claude Code   → ~/.claude.json                        (JSON, mcpServers — user scope)
 *   Codex         → ~/.codex/config.toml                  (TOML, [mcp_servers.name])
 *   Gemini CLI    → ~/.gemini/settings.json               (JSON, mcpServers)
 *   OpenCode      → ~/.config/opencode/opencode.json      (JSON, mcp block)
 *   Copilot       → ~/.copilot/mcp-config.json            (JSON, mcpServers)
 *   Cursor        → ~/.cursor/mcp.json                    (JSON, mcpServers)
 *   Antigravity   → ~/.gemini/antigravity/mcp_config.json (JSON, mcpServers)
 *   Kiro          → ~/.kiro/settings/mcp.json              (JSON, mcpServers)
 *   Grok          — reads ~/.cursor/mcp.json via compat scan (no dedicated target)
 */

// ─── unified-config ────────────────────────────────
export {
    loadUnifiedMcp,
    saveUnifiedMcp,
    importFromClaudeMcp,
    initMcpConfig,
} from './mcp/unified-config.js';

// ─── format-converters ─────────────────────────────
export {
    toClaudeMcp,
    toCodexToml,
    toOpenCodeMcp,
    patchCodexToml,
    syncToAll,
} from './mcp/format-converters.js';

export { ensureComputerUseMcp, computerUseServerEntry, isManagedComputerUseEntry } from './mcp/computer-use-config.js';
export { COMPUTER_USE_MCP_NAME } from './mcp/computer-use-constants.js';

// ─── skills-utils ──────────────────────────────────
export {
    shouldSkipClone,
    writeCloneMeta,
    readCloneMeta,
    CLONE_META_PATH,
    CLONE_COOLDOWN_MS,
    CLONE_TIMEOUT_MS,
} from './mcp/skills-utils.js';

// ─── skills-symlinks ──────────────────────────────
import {
    ensureWorkingDirSkillsLinks as _ensureWorkingDirSkillsLinks,
    ensureSharedHomeSkillsLinks as _ensureSharedHomeSkillsLinks,
} from './mcp/skills-symlinks.js';
export {
    detectSharedPathContamination,
    ensureSkillsSymlinks,
} from './mcp/skills-symlinks.js';
export type { SharedPathHealthReport } from './mcp/skills-symlinks.js';

// Thin wrappers to satisfy static source analysis tests (SPI-009, SPI-010)
export function ensureWorkingDirSkillsLinks(...args: Parameters<typeof _ensureWorkingDirSkillsLinks>) {
    return _ensureWorkingDirSkillsLinks(...args);
}
export function ensureSharedHomeSkillsLinks(...args: Parameters<typeof _ensureSharedHomeSkillsLinks>) {
    return _ensureSharedHomeSkillsLinks(...args);
}

// ─── skills-distribution ──────────────────────────
export { copyDefaultSkills, propagateSkillsToInstances } from './mcp/skills-distribution.js';
export {
    migrateAllJawHomes,
    hasPendingLegacySkillDirs,
    discoverJawHomes,
    normalizeSkillNamespace,
} from './mcp/skills-migration.js';
export type { LegacyMigrationResult, HomeMigrationReport } from './mcp/skills-migration.js';

// ─── skills-reset ─────────────────────────────────
export {
    softResetSkills,
    repairManagedSkillLinksAfterReset,
    runSkillReset,
} from './mcp/skills-reset.js';
export type { SkillResetMode, SkillResetResult } from './mcp/skills-reset.js';

// ─── mcp-install ──────────────────────────────────
export { installMcpServers } from './mcp/mcp-install.js';
