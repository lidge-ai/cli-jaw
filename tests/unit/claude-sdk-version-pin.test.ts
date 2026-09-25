import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAUDE_AGENT_SDK_PINNED_VERSION } from '../../src/agent/runtime/claude-sdk-version.ts';

const json = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));

test('pinned SDK constant matches package.json and the installed package', () => {
    const pkg = json('../../package.json');
    assert.equal(pkg.optionalDependencies['@anthropic-ai/claude-agent-sdk'], CLAUDE_AGENT_SDK_PINNED_VERSION);
    assert.equal(json('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json').version, CLAUDE_AGENT_SDK_PINNED_VERSION);
});

test('package-lock pins the SDK and every platform package to the same version', () => {
    const lock = json('../../package-lock.json');
    assert.equal(lock.packages[''].optionalDependencies['@anthropic-ai/claude-agent-sdk'], CLAUDE_AGENT_SDK_PINNED_VERSION);
    assert.equal(lock.packages[''].dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined, 'optional only');
    const root = lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'];
    assert.equal(root.version, CLAUDE_AGENT_SDK_PINNED_VERSION);
    const expected = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64',
        'linux-x64-musl', 'win32-arm64', 'win32-x64'].map(platform => `@anthropic-ai/claude-agent-sdk-${platform}`);
    assert.deepEqual(Object.keys(root.optionalDependencies ?? {}).sort(), expected.sort());
    for (const name of expected) {
        assert.equal(root.optionalDependencies[name], CLAUDE_AGENT_SDK_PINNED_VERSION, name);
        assert.equal(lock.packages[`node_modules/${name}`]?.version, CLAUDE_AGENT_SDK_PINNED_VERSION, name);
    }
});
