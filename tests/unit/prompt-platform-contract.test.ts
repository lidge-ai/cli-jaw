// #308 originally pinned the RIGHT Computer Use API per platform, because
// telling a Windows agent to call a macOS-only tool produced an opaque runtime
// error rather than a clean precondition failure.
//
// That intent still matters, but the tool names it asserted are gone. A current
// Codex build exposes no `mcp__computer_use__*` tool at all - even with the
// computer-use plugin enabled and declaring its MCP server - and provides a CUA
// JavaScript session instead. Pinning names made the templates fail closed
// against a surface that no longer exists.
//
// So these tests now assert what survives a host change: the prompts must tell
// the agent to establish the surface rather than assume it, must keep the
// platform SHAPE distinction (macOS app-scoped, Windows window-scoped), must
// preserve the two Windows results that look like success, and must keep the
// sandbox flag honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = (name: string) => path.resolve(here, '../../src/prompt/templates/', name);
const read = (name: string) => fs.readFileSync(T(name), 'utf8');

/** Lines that talk about Windows, used for the "never instruct X" checks. */
function windowsLines(source: string): string {
    return source
        .split('\n')
        .filter((line) => /windows/i.test(line))
        .join('\n');
}

for (const file of ['a1-system.md', 'employee.md']) {
    test(`PLAT-001 (${file}): tells the agent to establish the surface, not assume it`, () => {
        const src = read(file);
        assert.match(src, /jaw-computer-use/);
        assert.match(src, /do not assume (?:a tool name|tool names|APIs)/i);
    });

    test(`PLAT-002 (${file}): keeps the platform shape distinction`, () => {
        const src = read(file);
        assert.match(src, /app-scoped/i, 'macOS app-scoped shape must remain');
        assert.match(src, /window-scoped/i, 'Windows window-scoped shape must remain');
    });

    test(`PLAT-003 (${file}): never instructs a specific retired tool call on Windows`, () => {
        const windows = windowsLines(read(file));
        assert.ok(windows.length > 0, 'the file must actually mention Windows');
        assert.doesNotMatch(windows, /Windows[^.\n]*(?:call|use|start with|first action is)\s+`?get_app_state/i);
        assert.doesNotMatch(windows, /Windows[^.\n]*(?:call|use)\s+`?select_text/i);
    });
}

test('PLAT-004: a1-system keeps the two Windows results that look like success', () => {
    const a1 = read('a1-system.md');
    // An enumeration that answers is not a health check for the connection.
    assert.match(a1, /proves nothing about the connection|not a health/i,
        'an enumeration that answers must be marked as not proving connectivity');
    // An empty window list is a transport failure, not an empty result.
    assert.match(a1, /transport is not connected|not on the pipe/i,
        'an empty window list must be described as a transport precondition failure');
});

test('PLAT-005: a1-system states the Windows host precondition that still holds', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /logged-on/i, 'the logged-on session requirement must be stated');
});

test('PLAT-006: the sandbox bypass is named honestly and never auto-applied', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /dangerously-bypass-approvals-and-sandbox/,
        'the actual flag must be named, not euphemized');
    assert.match(a1, /never adds it automatically|never adds or persists/i,
        'the prompt must state cli-jaw does not add it for the user');
    assert.match(a1, /\bboth\b/i, 'it must be stated that BOTH approvals and sandbox are disabled');
});

test('PLAT-007: Linux and WSL remain denied', () => {
    const a1 = read('a1-system.md');
    assert.match(a1, /Linux\/WSL|WSL/, 'WSL must still be addressed');
    assert.match(a1, /no Computer Use host|CDP only|only the \*\*CDP browser path\*\*/i,
        'Linux/WSL must be pointed at CDP');
});

test('PLAT-008: no template hard-codes a Computer Use MCP tool name as the contract', () => {
    // The retired names may appear at most once per file, and only as historical
    // context explaining that older builds exposed them.
    for (const file of ['a1-system.md', 'employee.md']) {
        const src = read(file);
        const hits = src.match(/mcp__computer_use__/g) ?? [];
        assert.ok(hits.length <= 1,
            `${file} names the retired MCP surface ${hits.length} times; at most one historical mention is allowed`);
        if (hits.length === 1) {
            assert.match(src, /[Oo]lder builds exposed/,
                `${file} may only mention the retired name as historical context`);
        }
    }
});
