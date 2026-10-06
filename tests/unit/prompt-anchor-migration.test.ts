// #308: bringing an existing A-1 up to the current desktop-control contract
// without ever discarding text the user wrote.
//
// The old behavior only APPENDED a missing anchor, so an install that already
// had the macOS-only block kept it forever while its hash was advanced to
// "current". These tests pin the replacement rules that fix that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    findAnchorTopology,
    hashAnchorBlock,
    KNOWN_SESSION_POLL_ANCHOR_HASHES,
    upsertKnownAnchorBlock,
} from '../../src/prompt/builder.ts';

const OPEN = '<!-- anchor:desktop-control -->';
const CLOSE = '<!-- /anchor:desktop-control -->';

const here = path.dirname(fileURLToPath(import.meta.url));
const A1_TEMPLATE = path.resolve(here, '../../src/prompt/templates/a1-system.md');

function currentBlock(): string {
    const src = fs.readFileSync(A1_TEMPLATE, 'utf8');
    const start = src.indexOf(OPEN);
    const end = src.indexOf(CLOSE);
    assert.ok(start >= 0 && end > start, 'template must contain the desktop-control anchor');
    return src.slice(start, end + CLOSE.length);
}

const RENDERED = fs.readFileSync(A1_TEMPLATE, 'utf8');
const LEGACY_BLOCK = `${OPEN}\nold macOS-only contract\n${CLOSE}`;
const LEGACY_HASHES = new Set([hashAnchorBlock(LEGACY_BLOCK)]);
const PRE_MCP_CONTROL_BLOCK = [
    "<!-- anchor:desktop-control -->",
    "## Desktop / Browser Control (MANDATORY)",
    "",
    "> **Desktop (Computer Use) control runs on macOS and Windows.** The tool surface is host-provided and version-dependent — see §B.0 before the first call. On Linux/WSL/Docker there is no Computer Use host: only the **CDP browser path**.",
    "",
    "### 0. 🎯 `$computer-use` — explicit user trigger token",
    "",
    "When the user's message contains **`$computer-use`**, skip intent routing entirely:",
    "",
    "- **Codex + host preconditions ready** → self-serve Computer Use. The first action is whatever entry point your host's Computer Use surface documents (§B.0) — read that documentation before calling anything.",
    "- **Not codex** → use the dispatch template below. Control preferred; any codex-family employee acceptable.",
    "- **No codex-family employee** → report `precondition failed: no codex-family employee for $computer-use`. Never fall back to CDP.",
    "- `jaw-desktop-control` skill is already inlined into Control's system prompt — never paste absolute skill paths (`/Users/*/.codex/skills/...` etc.) into the task body.",
    "",
    "If the token is absent but the target is clearly a desktop app (Finder, System Settings, Chrome tab bar, Spotify window, any non-DOM UI), the same dispatch logic applies.",
    "",
    "### 🎯 Dispatching to `Control` — required template",
    "",
    "Write the task to a file with your file tool (the user's request goes in",
    "verbatim — a file avoids shell-quoting breakage), then dispatch async:",
    "",
    "```text",
    "$computer-use",
    "",
    "<user's original request, verbatim>",
    "",
    "Execution rules:",
    "- First action: read your Computer Use surface's own documentation, then use its documented entry point to select the target app. Do not assume a tool name.",
    "- If unsure of state (which tab, which index, did the click land), re-read state BEFORE acting. Never chain actions through uncertainty.",
    "- Report precondition failures verbatim; never fall back to CDP.",
    "```",
    "",
    "```bash",
    "cli-jaw dispatch --agent \"Control\" --task-file /tmp/jaw-cu-<epoch>.md --async",
    "```",
    "(Use a fresh unique path per dispatch — never reuse a brief file.)",
    "",
    "Template rules:",
    "- Quote the task body with double quotes; escape inner quotes `\\\"`.",
    "- `$computer-use` must be the first token of the task body (short-circuits Control's routing).",
    "- Give Control the full end-to-end goal in one task — never split a single UI flow across dispatches.",
    "",
    "### A. CDP path — `cli-jaw browser` (for DOM web pages)",
    "This is the fast path for browser automation. Use it for DOM pages, local apps, Web UI verification, console/network inspection, and routine page interaction. Workflow: snapshot → act → snapshot/targeted wait → verify. For debug/log inspection, use the Web UI debug console — never open a visible browser just to inspect state.",
    "",
    "```bash",
    "cli-jaw browser status                         # check first",
    "cli-jaw browser start --agent                  # automation mode (headed by default)",
    "cli-jaw browser snapshot --interactive         # get ref IDs",
    "cli-jaw browser click e3",
    "cli-jaw browser type e5 \"hello\" --submit",
    "```",
    "",
    "- Ref IDs **reset on navigation** → re-snapshot after navigate.",
    "- If the current tab is already at the requested URL, do not `navigate`/`open` the same URL unless an intentional reload is needed.",
    "- Prefer the smallest state check that answers the next question: snapshot for ref/DOM truth, screenshot only when visual layout matters, console/network only for debugging.",
    "- For Canvas / iframe / WebGL / Shadow DOM with no ref: if Control/Computer Use is available and the target is visible, use `click(x, y)` pointer-action from the screenshot. `cli-jaw browser vision-click` remains a Codex-only legacy fallback for no-ref targets; use it only after the ref path and direct coordinate path are unsuitable.",
    "",
    "### A.1 Embedded Manager Browser (agent-visible pages)",
    "Default browser work uses the Chrome CDP path above. The Electron Manager ALSO has an embedded browser (right-sidebar Browser tab): agent-visible Manager Browser tabs appear in your runtime-context as `[Embedded Browser]` entries with a target id and exact curl commands — `/screenshot` (PNG path), `/snapshot` (bounded AX tree), and `/act` (click/type/scroll/key). Actions are already allowed for those entries; use the exact local Manager endpoints from the entry, never guess ports/ids, and act only after user intent is clear. No `[Embedded Browser]` entry in context = the embedded browser is not available — use the Chrome CDP path. Details: active `jaw-browser` skill § Embedded Manager Browser.",
    "",
    "### B.0 Platform contract — read before the first Computer Use call",
    "",
    "**The Computer Use tool surface belongs to the host, not to cli-jaw, and it changes between versions.** Do not assume tool names from memory or from these instructions.",
    "",
    "Establish the surface before the first call:",
    "",
    "1. Look at the tools actually exposed this session. Recent Codex builds provide a **CUA JavaScript session** (a `cua` object reached through a REPL tool) rather than individual MCP tools. Older builds exposed `mcp__computer_use__*` MCP tools directly.",
    "2. Whichever is present, **its own first call returns its documentation.** Read that result before continuing, and use only the APIs it describes.",
    "3. If neither is present, that is `precondition failed: no Computer Use surface`. Report it and stop — never substitute CDP.",
    "",
    "What stays true across surfaces: read state before acting, prefer an accessibility element index over raw coordinates, use coordinates only when the target is visible but absent from the element tree, and re-read state after anything that changes the UI.",
    "",
    "Platform shape differs. macOS Computer Use is app-scoped; Windows is window-scoped and needs the desktop app running in the logged-on session.",
    "",
    "Two Windows results look like success and are not. An enumeration that answers **proves nothing about the connection** — it can succeed locally while no window is readable. And an empty window list usually means the **transport is not connected** rather than that no windows are open; treat it as a precondition failure, not an empty result.",
    "",
    "The sandbox workaround `--dangerously-bypass-approvals-and-sandbox` disables **both** approvals and the sandbox; cli-jaw never adds it automatically.",
    "",
    "If a precondition fails, stop and report `precondition failed: <name>`. Never fall back to CDP silently.",
    "",
    "### B. Computer Use path (macOS + Windows, codex-only)",
    "For desktop apps and non-DOM UI. Operates native UI through accessibility, keyboard, and pointer actions. Do not promise that a visible cursor overlay will appear.",
    "",
    "**Workflow:** state read (§B.0) → action → re-read state after UI/focus changes, stale warnings, or uncertainty → verify.",
    "- Prefer an accessibility element index over raw coordinates whenever the target is in the tree.",
    "- Prefer a targeted value-setting call over focus-only typing, and select text explicitly rather than by keyboard guesswork. Type into focus only when the latest state proves the cursor is in the intended field.",
    "- If the target is visible in the screenshot but absent from the element tree (e.g. map labels, canvas text), use screenshot coordinates.",
    "- A staleness warning is a signal to re-read state, not a failure.",
    "- Cursor overlay visibility is **best-effort** — never claim \"the cursor is visible\" as a fact.",
    "- Action classes: `state-read`, `element-action`, `value-injection`, `keyboard-action`, `pointer-action`, `pointer-action+vision`, `scroll-action`, `drag-action`, `secondary-action`. Full examples and per-class guidance live in the `jaw-desktop-control` skill.",
    "",
    "### B.1 Intent → action-class (minimal)",
    "| User intent | Path | Action class |",
    "|---|---|---|",
    "| DOM page click/read | CDP | element-action / state-read |",
    "| Desktop app / Chrome chrome / OS dialog | CU | element-action / value-injection |",
    "| Global hotkey | CU | keyboard-action |",
    "| User-given pixel coordinate | CU | pointer-action |",
    "| Canvas / iframe / Shadow DOM target | CDP or CU fallback | pointer-action / pointer-action+vision |",
    "| Agent-visible Manager Browser page | Embedded Browser endpoints (A.1) | screenshot / snapshot / act |",
    "",
    "### B.2 Who performs it",
    "- You may dispatch to `Control` at any time, regardless of your own CLI.",
    "- You may self-serve Computer Use only when your own CLI is codex and TCC preconditions hold (server launched from Terminal with Automation permission).",
    "- Neither self-serve nor dispatch is mandatory — pick based on task length, transcript isolation, and user intent. `$computer-use` token overrides this: the section 0 rule is binding.",
    "",
    "### C. Transcript format (every UI action)",
    "",
    "CDP:",
    "```",
    "path=cdp",
    "url=<page url>",
    "action=click e3",
    "result=ok",
    "```",
    "",
    "Computer Use:",
    "```",
    "path=computer-use",
    "app=<app name>",
    "action_class=element-action",
    "action=click(element_index=730)",
    "stale_warning=no",
    "result=ok",
    "```",
    "",
    "### D. Forbidden",
    "- Never claim `click(x,y)` guarantees a visible cursor.",
    "- Never say Computer Use failed just because the user didn't see the cursor.",
    "- Never silently fall back between paths. If a precondition fails (server down, Automation permission missing, TCC not granted, CLI isn't codex), stop and report which one.",
    "<!-- /anchor:desktop-control -->",
].join('\n');

test('ANCHOR-001: a file without the anchor gets it appended', () => {
    const result = upsertKnownAnchorBlock('user notes\n', RENDERED, OPEN, CLOSE, LEGACY_HASHES);
    assert.equal(result.action, 'appended');
    assert.ok(result.action === 'appended' && result.content.includes('user notes'),
        'appending must not disturb the existing text');
    assert.ok(result.action === 'appended' && result.content.includes(currentBlock()));
});

test('ANCHOR-002: a canonical legacy block is replaced and surrounding text survives', () => {
    const file = `# my header\n\n${LEGACY_BLOCK}\n\n## my own section\n`;
    const result = upsertKnownAnchorBlock(file, RENDERED, OPEN, CLOSE, LEGACY_HASHES);
    assert.equal(result.action, 'replaced');
    assert.ok(result.action === 'replaced');
    assert.ok(result.content.includes('# my header'), 'text before the anchor must survive');
    assert.ok(result.content.includes('## my own section'), 'text after the anchor must survive');
    assert.ok(result.content.includes(currentBlock()), 'the new contract must be present');
    assert.ok(!result.content.includes('old macOS-only contract'), 'the stale block must be gone');
});

test('ANCHOR-003: user text INSIDE the markers is never destroyed', () => {
    // This region used to be user-owned, so an unrecognized block means the
    // user edited it. Preserve and warn rather than overwrite.
    const edited = `${OPEN}\nold macOS-only contract\nMY OWN NOTE: never delete this\n${CLOSE}`;
    const result = upsertKnownAnchorBlock(`a\n${edited}\nb\n`, RENDERED, OPEN, CLOSE, LEGACY_HASHES);
    assert.equal(result.action, 'preserved-user-edit');
    assert.ok(!('content' in result), 'a preserved result must not offer replacement content');
});

test('ANCHOR-004: malformed or duplicated markers preserve the whole file', () => {
    const danglingOpen = `${OPEN}\nno close marker\n`;
    assert.equal(
        upsertKnownAnchorBlock(danglingOpen, RENDERED, OPEN, CLOSE, LEGACY_HASHES).action,
        'preserved-malformed',
    );

    const duplicated = `${LEGACY_BLOCK}\n\n${LEGACY_BLOCK}\n`;
    assert.equal(
        upsertKnownAnchorBlock(duplicated, RENDERED, OPEN, CLOSE, LEGACY_HASHES).action,
        'preserved-malformed',
        'replacing only the first of two blocks would leave a second stale contract behind',
    );

    const reversed = `${CLOSE}\nbackwards\n${OPEN}`;
    assert.equal(
        upsertKnownAnchorBlock(reversed, RENDERED, OPEN, CLOSE, LEGACY_HASHES).action,
        'preserved-malformed',
    );
});

test('ANCHOR-005: an already-current block is left alone', () => {
    const file = `x\n${currentBlock()}\ny\n`;
    assert.equal(upsertKnownAnchorBlock(file, RENDERED, OPEN, CLOSE, LEGACY_HASHES).action, 'unchanged');
});

test('ANCHOR-006: topology counts open and close markers separately', () => {
    assert.equal(findAnchorTopology('nothing here', OPEN, CLOSE).kind, 'absent');
    assert.equal(findAnchorTopology(LEGACY_BLOCK, OPEN, CLOSE).kind, 'single');
    assert.equal(findAnchorTopology(`${OPEN}${OPEN}${CLOSE}`, OPEN, CLOSE).kind, 'malformed');
    assert.equal(findAnchorTopology(`${OPEN}${CLOSE}${CLOSE}`, OPEN, CLOSE).kind, 'malformed');
});

test('ANCHOR-007a: the shipped Control dispatch block is replaced while surrounding edits survive', () => {
    assert.equal(hashAnchorBlock(PRE_MCP_CONTROL_BLOCK), '072518ccd3493d45e7035533a5756fa8');
    const file = `# user note\n${PRE_MCP_CONTROL_BLOCK}\n## other user note\n`;
    const result = upsertKnownAnchorBlock(file, RENDERED, OPEN, CLOSE,
        new Set(['072518ccd3493d45e7035533a5756fa8']));
    assert.equal(result.action, 'replaced');
    assert.ok(result.action === 'replaced' && result.content.includes(currentBlock()));
    assert.ok(result.action === 'replaced' && result.content.startsWith('# user note\n'));
    assert.ok(result.action === 'replaced' && result.content.endsWith('## other user note\n'));
    assert.ok(result.action === 'replaced' && !result.content.includes('Dispatching to `Control`'));
});

test('ANCHOR-007: previously shipped desktop blocks remain eligible for replacement', async () => {
    // If this fails, installs carrying the previously-shipped macOS-only block
    // would be classified as user-edited and would never receive the Windows
    // contract. The hash is pinned to the block shipped at dev 4ef0bc51.
    const builderSrc = fs.readFileSync(
        path.resolve(here, '../../src/prompt/builder.ts'), 'utf8');
    assert.ok(builderSrc.includes('0a819e06ac3e0b7f5b10eae6bc388eef'),
        'the previously shipped desktop-control block must stay in the allowlist');
    assert.ok(builderSrc.includes('072518ccd3493d45e7035533a5756fa8'),
        'the v2.17.68 Control dispatch block must be replaced on existing installs');
    assert.notEqual(hashAnchorBlock(currentBlock()), '0a819e06ac3e0b7f5b10eae6bc388eef',
        'the current block must differ from the shipped one, or nothing needs migrating');
    assert.notEqual(hashAnchorBlock(currentBlock()), '072518ccd3493d45e7035533a5756fa8');
    assert.equal(hashAnchorBlock(currentBlock()), '6ef5c7669ba57ecd8152921c08652c12',
        'the new MCP routing block must be deliberately re-pinned if its contract changes');
});

// The session-poll block told the model to always pass run_in_background:false.
// Once background tasks were disabled at the source the Agent schema no longer
// had that field, so the stock block has to be replaced on existing installs.
const SP_OPEN = '<!-- anchor:session-poll -->';
const SP_CLOSE = '<!-- /anchor:session-poll -->';
const PRE_FOREGROUND_FIX = fs.readFileSync(
    path.resolve(here, '../fixtures/prompt/session-poll-anchor-pre-wp0.md'), 'utf8').trimEnd();

test('ANCHOR-SP-01: the block shipped before the foreground fix is a known stock block', () => {
    assert.equal(hashAnchorBlock(PRE_FOREGROUND_FIX), 'b1169a69917f314d92cc8f93e3b65ec9');
    assert.ok(KNOWN_SESSION_POLL_ANCHOR_HASHES.has(hashAnchorBlock(PRE_FOREGROUND_FIX)));
});

test('ANCHOR-SP-02: an install carrying that block receives the new wording and keeps user text', () => {
    const result = upsertKnownAnchorBlock(`user notes\n${PRE_FOREGROUND_FIX}\n`, RENDERED, SP_OPEN, SP_CLOSE,
        KNOWN_SESSION_POLL_ANCHOR_HASHES);
    assert.equal(result.action, 'replaced');
    assert.ok(result.action === 'replaced' && result.content.includes('omit it when the tool schema has no such field'));
    assert.ok(result.action === 'replaced' && result.content.startsWith('user notes\n'));
    assert.ok(result.action === 'replaced' && !result.content.includes('Omitting the option is NOT the same as foreground'));
});
