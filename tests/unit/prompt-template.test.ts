// Desktop/Browser routing contract and action guidance.


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const A1_PATH = path.resolve(here, '..', '..', 'src', 'prompt', 'templates', 'a1-system.md');
const CONTROL_SYS_PATH = path.resolve(here, '..', '..', 'src', 'prompt', 'templates', 'control-system.md');

function readA1(): string {
    return fs.readFileSync(A1_PATH, 'utf8');
}

test('P37-PROMPT-001: A1 carries Desktop/Browser Control anchor pair', () => {
    const a1 = readA1();
    assert.match(a1, /<!-- anchor:desktop-control -->/);
    assert.match(a1, /<!-- \/anchor:desktop-control -->/);
});

test('P37-PROMPT-002: A1 has both CDP path and Computer Use path sections', () => {
    const a1 = readA1();
    assert.match(a1, /CDP path/);
    assert.match(a1, /Computer Use path/);
    assert.match(a1, /jaw-computer-use/);
    assert.match(a1, /first call returns its documentation/i);
    assert.doesNotMatch(a1, /^\s*-\s*\*\*macOS:\*\*\s*`get_app_state/m);
});

test('P37-PROMPT-003: A1 names all Computer Use action classes', () => {
    const a1 = readA1();
    for (const cls of ['state-read', 'element-action', 'value-injection', 'keyboard-action', 'pointer-action']) {
        assert.match(a1, new RegExp(cls), `missing action class: ${cls}`);
    }
});

test('P37-PROMPT-004: A1 contains three forbidden phrases (explicit bans)', () => {
    const a1 = readA1();
    assert.match(a1, /visible cursor/i);
    assert.match(a1, /silently fall back/i);
    assert.match(a1, /Never (claim|say)/i);
});

test('P37-PROMPT-005: A1 lets any MCP-aware CLI self-serve', () => {
    const a1 = readA1();
    assert.match(a1, /Who performs it/i);
    assert.match(a1, /Any boss or employee whose CLI exposes `jaw-computer-use`/);
    assert.doesNotMatch(a1, /dispatch --agent "Control"/);
});

test('P37-PROMPT-006: A1 intent→action-class matrix row exists', () => {
    const a1 = readA1();
    // the intent/path/action-class header row should be present
    assert.match(a1, /\| *User intent[^\n]*\| *Path *\| *Action class *\|/);
});

test('P37-PROMPT-007: A1 transcript format shows path= and action_class=', () => {
    const a1 = readA1();
    assert.match(a1, /path=cdp/);
    assert.match(a1, /path=computer-use/);
    assert.match(a1, /action_class=/);
    assert.match(a1, /stale_warning=/);
});

test('P37-PROMPT-008: retired Control system prompt is absent', () => {
    assert.equal(fs.existsSync(CONTROL_SYS_PATH), false);
});

test('P37-PROMPT-009: Computer Use guidance prefers explicit text selection over keyboard guesswork', () => {
    const a1 = readA1();
    assert.match(a1, /select text explicitly rather than by keyboard guesswork/);
});

test('P40-PROMPT-010: A1 gates external realtime lookup through active search skill', () => {
    const a1 = readA1();

    assert.match(a1, /Search routing — file vs web/);
    assert.match(a1, /BEFORE any external\/web\/X\/real-time search/);
    assert.match(a1, /MUST read the active search skill once per session/);
    assert.match(a1, /skills\/jaw-search\/SKILL\.md/);
    assert.match(a1, /provider rules NOT repeated here/);
});

test('P40-PROMPT-011: A1 keeps programming docs before generic search when applicable', () => {
    const a1 = readA1();

    assert.match(a1, /programming library\/framework\/API documentation/);
    assert.match(a1, /Context7 or official docs search first when available/);
    assert.ok(
        a1.indexOf('Context7 or official docs search first when available') < a1.indexOf('Treat search results as URL candidates'),
        'official documentation routing should appear before evidence handling'
    );
});

test('P40-PROMPT-012: A1 treats search results as URL candidates and browser verification as downstream', () => {
    const a1 = readA1();

    assert.match(a1, /Treat search results as URL candidates, not final evidence/);
    assert.match(a1, /fetch\/open the original page/);
    assert.match(a1, /Use browser\/browse escalation only as downstream verification/);
    assert.match(a1, /Naver shell\/PDF\/table-only evidence/);
});
