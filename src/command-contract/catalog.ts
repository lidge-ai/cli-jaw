// ─── Command Contract: Capability Catalog ────────────
// Phase 9.5 → Phase 00: /model, /cli Telegram full 승격
// Active skills are not slash commands: they are picked with `$skill-id`
// (src/shared/skill-mention.ts). `/skill:<id>` still executes as a hidden alias.

import { COMMANDS } from '../cli/commands.js';

export const CAPABILITY = {
    full: 'full',         // 실행 가능
    readonly: 'readonly', // 조회만 가능
    hidden: 'hidden',     // 목록에서 숨김
    blocked: 'blocked',   // 실행 차단
};

// Remote readonly targets — shared by telegram + discord
// Phase 00: /model, /cli 허용으로 비워짐
const REMOTE_READONLY = new Set<string>();
// root CLI는 서브커맨드 체계
const CMDLINE_HIDDEN = new Set(['help', 'clear', 'model', 'cli', 'fallback',
    'status', 'reset', 'skill', 'employee', 'mcp', 'memory', 'browser', 'prompt', 'version', 'stop', 'approve', 'deny']);

/**
 * COMMANDS 배열에 인터페이스별 capability map 추가
 * @returns {Array} 확장된 커맨드 배열
 */
export function getCommandCatalog() {
    const base = COMMANDS.map(cmd => ({
        ...cmd,
        capability: (cmd as Record<string, any>)["capability"] || {
            cli: cmd.interfaces.includes('cli')
                ? CAPABILITY.full
                : CAPABILITY.hidden,
            web: cmd.interfaces.includes('web')
                ? (cmd.hidden ? CAPABILITY.hidden : CAPABILITY.full)
                : CAPABILITY.hidden,
            telegram: cmd.interfaces.includes('telegram')
                ? (REMOTE_READONLY.has(cmd.name) ? CAPABILITY.readonly : CAPABILITY.full)
                : CAPABILITY.hidden,
            discord: cmd.interfaces.includes('discord')
                ? (REMOTE_READONLY.has(cmd.name) ? CAPABILITY.readonly : CAPABILITY.full)
                : CAPABILITY.hidden,
            slack: cmd.interfaces.includes('slack')
                ? (REMOTE_READONLY.has(cmd.name) ? CAPABILITY.readonly : CAPABILITY.full)
                : CAPABILITY.hidden,
            cmdline: CMDLINE_HIDDEN.has(cmd.name) || cmd.category === 'workflow'
                ? CAPABILITY.hidden
                : CAPABILITY.full,
        },
    }));

    return base;
}
