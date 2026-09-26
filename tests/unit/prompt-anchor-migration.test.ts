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

test('ANCHOR-007: the shipped v2.2.19 block is in the committed allowlist', async () => {
    // If this fails, installs carrying the previously-shipped macOS-only block
    // would be classified as user-edited and would never receive the Windows
    // contract. The hash is pinned to the block shipped at dev 4ef0bc51.
    const builderSrc = fs.readFileSync(
        path.resolve(here, '../../src/prompt/builder.ts'), 'utf8');
    assert.ok(builderSrc.includes('0a819e06ac3e0b7f5b10eae6bc388eef'),
        'the previously shipped desktop-control block must stay in the allowlist');
    assert.notEqual(hashAnchorBlock(currentBlock()), '0a819e06ac3e0b7f5b10eae6bc388eef',
        'the current block must differ from the shipped one, or nothing needs migrating');
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
