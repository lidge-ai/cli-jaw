// #308: the public desktop-control skill and its registry entry must not
// regress to macOS-only, and must keep the two platform APIs distinct.
//
// These read the skills_ref submodule, so a skills change requires the gitlink
// to be bumped before root tests pass — which is the point: the shipped skill
// and the shipped prompt cannot drift apart silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const SKILL = path.join(ROOT, 'skills_ref/jaw-desktop-control/SKILL.md');
const CU_REF = path.join(ROOT, 'skills_ref/jaw-desktop-control/reference/computer-use.md');
const REGISTRY = path.join(ROOT, 'skills_ref/registry.json');

const hasSkills = fs.existsSync(SKILL);
const maybe = { skip: hasSkills ? false : 'skills_ref submodule not checked out' };

test('DCS-001: the skill no longer declares macOS as a hard system requirement', maybe, () => {
    const src = fs.readFileSync(SKILL, 'utf8');
    assert.doesNotMatch(src, /"system":\s*\[\s*"macOS"/, 'macOS must not be a hard requirement');
    assert.doesNotMatch(src, /^- macOS only\.$/m, 'the macOS-only precondition must be gone');
});

test('DCS-002: the registry entry does not require macOS', maybe, () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const entry = registry.skills['jaw-desktop-control'];
    assert.ok(entry, 'jaw-desktop-control must exist in the registry');
    assert.ok(!entry.requires.system.includes('macOS'),
        'requiring macOS here re-gates Windows hosts out of Computer Use');
    assert.ok(entry.requires.system.includes('Google Chrome'), 'the Chrome requirement stays');
});

// DCS-003 and DCS-004 used to require the literal tool names `list_windows()`,
// `get_window_state`, `get_app_state(app)`, `select_text` and `node_repl`.
//
// Those names came from an older Codex build. On a current host the
// `computer-use@openai-bundled` plugin can be enabled, its `.mcp.json` can
// still declare the server, and NO `mcp__computer_use__*` tool is exposed to
// the session — the host provides a CUA JavaScript session instead. So the
// assertions were pinning an inventory that no longer resolves, and passing
// them meant the reference had to keep instructing calls that do not exist.
//
// What survives a host change is the platform SHAPE, which is what these check
// now: app-scoped on macOS, window-scoped on Windows, no host on Linux. The
// tests must not name tools for the same reason the reference stopped naming
// them.

test('DCS-003: the reference keeps the platform shapes distinct', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /macOS[^\n]*\bapp-scoped\b/i);
    assert.match(ref, /Windows is[^\n]*\bwindow-scoped\b/i);
    assert.match(ref, /Linux[^\n]*no Computer Use host/i,
        'a platform without a host must be named, or an agent will hunt for one');
});

test('DCS-004: the reference tells the agent to establish the surface rather than assume it', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /jaw-computer-use/);
    assert.match(ref, /first call[^\n]*documentation/i);
    assert.match(ref, /precondition failed: no Computer Use surface/);
    assert.match(ref, /precondition failed: computer-use app access blocked/);
    assert.match(ref, /`auto`\s+approves/i);
    assert.match(ref, /`safe`\s+declines/i);
});

test('DCS-005: the two Windows false-success traps are documented', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    // Stated as behaviour rather than by tool name: an enumeration that answers
    // proves nothing about the connection, and an empty list means the
    // transport is down rather than that the desktop is empty.
    assert.match(ref, /enumeration that answers is not a health check/i);
    assert.match(ref, /empty window list[^\n]*transport is not connected/i);
});

test('DCS-006: the sandbox bypass is stated as an attended user choice, not a default', maybe, () => {
    const ref = fs.readFileSync(CU_REF, 'utf8');
    assert.match(ref, /dangerously-bypass-approvals-and-sandbox/);
    // The wording moved from "never adds it automatically" to naming what
    // cli-jaw does not do — add OR persist it — and the claim got stronger,
    // so match the claim rather than the old sentence.
    assert.match(ref, /does not add or persist it/i);
    assert.match(ref, /attended, explicit user choice/i);
    // The sentence wraps across a line, so match without spanning the break.
    assert.match(ref, /permissions=auto/);
    assert.match(ref, /is not an equivalent substitute/i,
        'the quieter route to the same authority must be closed off by name');
});
