import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { buildSlackTextPayloads } from '../../src/slack/format.ts';
import { expectedRichFeatures, storedRichFeatures } from '../../src/slack/render-features.ts';
import { sendSlackText } from '../../src/slack/send-only-client.ts';
import { buildSlackBlockPayloads, expectedTableShapes, type SlackBlock } from '../../src/slack/blocks.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

// Golden native blocks captured from a test conversation, stripped of IDs.
// They are not produced by the formatter under test.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/slack-rich-message.json', import.meta.url), 'utf8'));
const features = ['bold', 'bullet_list', 'checked', 'checklist', 'code', 'divider', 'heading', 'inline_code', 'italic', 'language:python', 'link', 'nested_list', 'ordered_list', 'quote', 'strike', 'unchecked'];
const target = { channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D_FIXTURE', threadId: '41.1' } as const;

function vendor(blocks: unknown) {
    const posts: Record<string, unknown>[] = [];
    const reads: URLSearchParams[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/chat.postMessage')) {
            posts.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ ok: true, ts: '42.1' }));
        }
        assert.ok(String(url).endsWith('/conversations.replies'));
        const params = new URLSearchParams(String(init?.body));
        reads.push(params);
        assert.equal(params.get('channel'), 'D_FIXTURE');
        assert.equal(params.get('ts'), '41.1');
        assert.equal(params.get('oldest'), '42.1');
        return new Response(JSON.stringify({ ok: true, messages: [{ ts: '42.1', blocks }] }));
    }) as typeof fetch;
    return { posts, reads, fetchImpl };
}

test('a normal reply automatically preserves all demonstrated rich features in one message', async () => {
    const prepared = buildSlackTextPayloads(fixture.markdown);
    assert.equal(prepared.length, 1, 'one compact answer should not become many notifications');
    assert.deepEqual(expectedRichFeatures(prepared[0]!.blocks), features);
    assert.deepEqual(storedRichFeatures(fixture.storedBlocks), features);
    const fake = vendor(fixture.storedBlocks);
    const result = await sendSlackText('xoxb-fixture', target, fixture.markdown, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.delivery?.verification, 'verified');
    assert.equal(result.delivery?.tableContent, 'not_checked');
    assert.equal(result.delivery?.richContent, 'not_checked');
    assert.equal(result.delivery?.sourceAccuracy, 'not_checked');
    assert.equal(result.delivery?.comparisonVersion, 1);
    assert.deepEqual(result.delivery?.verifiedFeatures, features);
    assert.equal(fake.posts.length, 1);
    assert.equal(fake.reads.length, 1);
    const payload = fake.posts[0]!;
    assert.equal(payload['thread_ts'], '41.1');
    assert.match(JSON.stringify(payload['blocks']), /```python/);
    assert.match(JSON.stringify(payload['blocks']), /- \[x\]/);
});

function alter(value: unknown, feature: string): unknown {
    if (Array.isArray(value)) return value.map(v => alter(v, feature)).filter(Boolean);
    if (!value || typeof value !== 'object') return value;
    const node = structuredClone(value) as Record<string, unknown>;
    if ((feature === 'heading' && node['type'] === 'header')
        || (feature === 'quote' && node['type'] === 'rich_text_quote')
        || (feature === 'divider' && node['type'] === 'divider')) return null;
    if (feature === 'language:python') delete node['language'];
    if (feature === 'bold' && node['style'] && typeof node['style'] === 'object') delete (node['style'] as Record<string, unknown>)['bold'];
    if (feature === 'unchecked' && node['checked'] === false) delete node['checked'];
    for (const key of ['elements', 'blocks']) if (Array.isArray(node[key])) node[key] = alter(node[key], feature);
    return node;
}

for (const feature of ['heading', 'quote', 'divider', 'language:python', 'bold', 'unchecked']) {
    test(`a stored message missing ${feature} is not a successful rich delivery`, async () => {
        const fake = vendor(alter(fixture.storedBlocks, feature));
        const result = await sendSlackText('xoxb-fixture', target, fixture.markdown, { fetchImpl: fake.fetchImpl });
        assert.equal(result.ok, true);
        assert.equal(result.delivery?.verification, 'failed');
        assert.equal(result.delivery?.messages[0]?.verification, 'failed');
        assert.equal(result.sent, true);
        assert.equal(result.retryable, false);
        assert.match(result.delivery!.messages[0]!.error!, /missing_rich_features/);
        assert.ok(result.delivery!.messages[0]!.error!.includes(feature));
        assert.equal(fake.posts.length, 1, 'verification failure must never repost');
    });
}

test('packing many headings preserves every heading and bounds block expansion', () => {
    const titles = Array.from({ length: 75 }, (_, i) => `항목 ${i + 1}`);
    const prepared = buildSlackTextPayloads(titles.map(t => `## ${t}`).join('\n\n'));
    assert.equal(prepared.length, 3);
    const observed = prepared.flatMap(p => marked.lexer(p.text).filter(t => t.type === 'heading').map(t => t.text));
    assert.deepEqual(observed, titles);
});

test('large code retains its language and every character while splitting', () => {
    const code = 'x'.repeat(22000);
    const prepared = buildSlackTextPayloads(`\`\`\`python\n${code}\n\`\`\``);
    assert.ok(prepared.length > 1);
    const tokens = prepared.flatMap(p => marked.lexer(p.text));
    assert.ok(tokens.every(t => t.type === 'code' || t.type === 'space'));
    const bodies = tokens.filter(t => t.type === 'code');
    assert.ok(bodies.every(t => t.lang === 'python'));
    assert.equal(bodies.map(t => t.text).join(''), code);
});

test('remote images become images; local assets retain labels without exposing paths or modifying code examples', () => {
    const remote = buildSlackTextPayloads('![설명](https://example.com/asset.png)');
    assert.deepEqual(remote[0]!.blocks, [{ type: 'image', image_url: 'https://example.com/asset.png', alt_text: '설명' }]);
    assert.deepEqual(expectedRichFeatures(remote[0]!.blocks), ['image']);
    const local = buildSlackTextPayloads('완료\n![결과](/tmp/private-image.png)');
    assert.ok(!JSON.stringify(local).includes('/tmp/private-image.png'));
    assert.ok(JSON.stringify(local).includes('결과'));
    const literal = buildSlackTextPayloads('`![결과](/tmp/private-image.png)`');
    assert.ok(JSON.stringify(literal).includes('/tmp/private-image.png'), 'code is literal content, not a file relay marker');
});

test('an oversized formatted span fails before posting rather than losing formatting', async () => {
    const fake = vendor([]);
    const result = await sendSlackText('xoxb-fixture', target, `**${'x'.repeat(10000)}**`, { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(fake.posts.length, 0);
});

test('an image URL erased by the shared privacy masker cannot silently degrade to text', async () => {
    const fake = vendor([]);
    const result = await sendSlackText('xoxb-fixture', target,
        '![예시](https://avatars.slack-edge.com/private-asset.png)', { fetchImpl: fake.fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error!, /slack_image_url_redacted/);
    assert.equal(fake.posts.length, 0);
});

test('linked and formatted headings retain clickable/code semantics in both input paths', () => {
    const markdown = '## [문서](https://example.com)와 `status`\n\n본문';
    for (const parts of [buildSlackTextPayloads(markdown), buildSlackBlockPayloads('알림', [{ type: 'markdown', text: markdown }])]) {
        assert.equal(parts.length, 1);
        assert.deepEqual(expectedRichFeatures(parts[0]!.blocks), ['bold', 'inline_code', 'link']);
        assert.match(JSON.stringify(parts[0]!.blocks), /\*\*\[문서\]/);
    }
});

test('one table with blocks after it posts as one message; a further table takes the blocks before it', async () => {
    const table = { type: 'table', rows: [[{ type: 'raw_text', text: 'cell' }]] };
    const after = { type: 'section', text: { type: 'mrkdwn', text: 'after' } };
    const { posts, fetchImpl } = vendor([table, after]);
    const result = await sendSlackText('xoxb-fixture', target, 'card', { fetchImpl, blocks: [table, after] });
    assert.equal(result.ok, true);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.['blocks'], [table, after]);
    const split = buildSlackBlockPayloads('card', [table, after, table, after]);
    assert.deepEqual(split.map(part => part.blocks), [[table], [after, table, after]]);
});

const carryTable = { type: 'table', rows: [[{ type: 'raw_text', text: 'cell' }]] };
const carryHeader = { type: 'header', text: { type: 'plain_text', text: 'B' } };
const carryMarkdown = (text: string) => ({ type: 'markdown', text });
const carryLong = carryMarkdown('p'.repeat(3900));
const carryHeading = carryMarkdown('## Second\n\n' + 'q'.repeat(180));
const carryGfm = carryMarkdown('| a | b |\n| - | - |\n| ' + 'x'.repeat(120) + ' | 2 |');
const limit50 = () => [carryTable, carryMarkdown(Array.from({ length: 48 }, (_, i) => `## \`h${i}\``).join('\n\n')), carryHeader, carryTable];
const limitChars = () => [carryTable, carryLong, carryLong, carryLong, carryHeading, carryGfm];
const blockLists = (blocks: unknown) => buildSlackBlockPayloads('card', blocks).map(p => p.blocks as SlackBlock[]);
const markdownChars = (blocks: SlackBlock[]) => blocks.reduce((n, b) => n + (b.type === 'markdown' ? String(b['text']).length : 0), 0);

test('a second table arriving at the 50-block limit takes the heading before it', () => {
    const parts = blockLists(limit50());
    assert.deepEqual(parts.map(p => p.length), [1, 50]);
    assert.deepEqual(parts[0], [carryTable]);
    assert.ok(parts[1]!.slice(0, 48).every(block => block.type === 'markdown'));
    assert.deepEqual(parts[1]!.slice(-2), [carryHeader, carryTable]);
});

test('a second table arriving at the markdown-character limit takes the heading before it', () => {
    const parts = blockLists(limitChars());
    assert.deepEqual(parts, [[carryTable, carryLong], [carryLong, carryLong, carryHeading, carryGfm]]);
    assert.ok(parts.every(p => markdownChars(p) <= 12000));
});

test('a third table after a trimmed carry keeps source order, both limits and the section before it', () => {
    const section = { type: 'section', text: { type: 'mrkdwn', text: 'third' } };
    const blocks = [...limitChars(), section, carryTable];
    const parts = blockLists(blocks);
    assert.deepEqual(parts, [[carryTable, carryLong], [carryLong, carryLong, carryHeading, carryGfm], [section, carryTable]]);
    assert.deepEqual(parts.flat(), blocks);
    assert.ok(parts.every(p => p.length <= 50 && markdownChars(p) <= 12000 && expectedTableShapes(p).length === 1));
});

for (const excess of [0, 1]) test(`${12000 + excess} carried markdown characters ${excess ? 'leave the first block with the earlier table' : 'fit with the later table'}`, () => {
    const prefix = '| a | b |\n| - | - |\n| ';
    const suffix = ' | 2 |';
    const table = carryMarkdown(prefix + 'x'.repeat(300 + excess - prefix.length - suffix.length) + suffix);
    const parts = blockLists([carryTable, carryLong, carryLong, carryLong, table]);
    assert.equal(markdownChars([carryLong, carryLong, carryLong, table]), 12000 + excess);
    assert.deepEqual(parts, excess ? [[carryTable, carryLong], [carryLong, carryLong, table]] : [[carryTable], [carryLong, carryLong, carryLong, table]]);
});

test('nested tables in one block are rejected before anything is sent', async () => {
    const nested = carryMarkdown('> | a | b |\n> | - | - |\n> | 1 | 2 |\n>\n> text\n>\n> | c | d |\n> | - | - |\n> | 3 | 4 |');
    assert.equal(expectedTableShapes([nested]).length, 2);
    assert.throws(() => buildSlackBlockPayloads('card', [nested]), /slack_nested_tables_require_separate_blocks/);
    const fake = vendor([]);
    const result = await sendSlackText('xoxb-fixture', target, 'card', { fetchImpl: fake.fetchImpl, blocks: [nested] });
    assert.equal(result.ok, false);
    assert.match(result.error!, /slack_nested_tables_require_separate_blocks/);
    assert.equal(fake.posts.length, 0);
});

test('the same renderer and readback work across recipients, channel kinds and concurrent sends', async () => {
    const targets: RemoteTarget[] = [
        { channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D_USER_A' },
        { channel: 'slack', targetKind: 'user', peerKind: 'direct', targetId: 'D_USER_B', threadId: '40.2' },
        { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_PUBLIC' },
        { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C_PUBLIC', threadId: '40.4' },
        { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'G_PRIVATE', threadId: '40.5' },
        { channel: 'slack', targetKind: 'user', peerKind: 'group', targetId: 'G_GROUP', threadId: '40.6' },
    ];
    const allPosts: Record<string, unknown>[] = [];
    const results = await Promise.all(targets.map(async (destination, i) => {
        const ts = `50.${i + 1}`;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).endsWith('/chat.postMessage')) {
                const post = JSON.parse(String(init?.body));
                allPosts.push(post);
                assert.equal(post.channel, destination.targetId);
                assert.equal(post.thread_ts, destination.threadId);
                await Promise.resolve();
                return new Response(JSON.stringify({ ok: true, ts }));
            }
            assert.ok(String(url).endsWith(destination.threadId ? '/conversations.replies' : '/conversations.history'));
            const params = new URLSearchParams(String(init?.body));
            assert.equal(params.get('channel'), destination.targetId);
            assert.equal(params.get('ts'), destination.threadId ?? null);
            assert.equal(params.get('oldest'), ts);
            return new Response(JSON.stringify({ ok: true, messages: [{ ts, blocks: fixture.storedBlocks }] }));
        }) as typeof fetch;
        return sendSlackText('xoxb-fixture', destination, fixture.markdown, { fetchImpl });
    }));
    assert.equal(allPosts.length, targets.length);
    assert.ok(allPosts.every(post => JSON.stringify(post['blocks']) === JSON.stringify(allPosts[0]!['blocks'])));
    assert.ok(results.every(result => result.ok && result.delivery?.verification === 'verified'));
    assert.deepEqual(results.map(r => r.delivery?.messageTs), targets.map((_, i) => [`50.${i + 1}`]));
});
