import test from 'node:test';
import assert from 'node:assert/strict';
import { fromFetchResult, fromNetworkCandidate } from '../../src/browser/adaptive-fetch/reader-adapters.js';

function fetched(text: string, contentType = 'application/json') {
    return {
        ok: true,
        status: 200,
        finalUrl: 'https://endpoint.example/test',
        contentType,
        text,
        evidence: ['http-200', contentType],
        warnings: [],
    };
}

test('public endpoint normalizers convert registry APIs into readable evidence', () => {
    const npm = fromFetchResult(fetched(JSON.stringify({
        name: '@scope/pkg',
        version: '1.2.3',
        description: 'Scoped package',
        license: 'MIT',
        homepage: 'https://example.com/pkg',
        repository: { url: 'git+https://github.com/org/pkg.git' },
        'dist-tags': { latest: '1.2.4' },
    })), { source: 'public_endpoint', label: 'npm-registry-version' });
    assert.equal(npm.title, '@scope/pkg@1.2.3');
    assert.match(npm.text, /Package: @scope\/pkg@1\.2\.3/);
    assert.match(npm.text, /Latest: 1\.2\.4/);
    assert.match(npm.text, /Repository: https:\/\/github\.com\/org\/pkg\.git/);
    assert.ok(!npm.text.includes('"dist-tags"'), 'should not expose raw JSON as the primary text');

    const pypi = fromFetchResult(fetched(JSON.stringify({
        info: {
            name: 'requests',
            version: '2.32.0',
            summary: 'Python HTTP',
            package_url: 'https://pypi.org/project/requests/',
            requires_python: '>=3.8',
        },
    })), { source: 'public_endpoint', label: 'pypi-json' });
    assert.match(pypi.text, /Package: requests 2\.32\.0/);
    assert.match(pypi.text, /Requires Python: >=3\.8/);
});

test('public endpoint normalizers convert community APIs into readable evidence', () => {
    const hn = fromFetchResult(fetched(JSON.stringify({
        id: 123,
        title: 'Launch HN',
        by: 'alice',
        score: 42,
        descendants: 7,
        url: 'https://example.com',
    })), { source: 'public_endpoint', label: 'hacker-news-item-api' });
    assert.match(hn.text, /Hacker News: Launch HN/);
    assert.match(hn.text, /Comments: 7/);

    const stack = fromFetchResult(fetched(JSON.stringify({
        items: [{
            question_id: 99,
            title: 'How to test',
            score: 10,
            answer_count: 2,
            is_answered: true,
            link: 'https://stackoverflow.com/q/99',
            body: '<p>Use a focused fixture.</p>',
        }],
    })), { source: 'public_endpoint', label: 'stackexchange-question-api' });
    assert.match(stack.text, /Stack Exchange: How to test/);
    assert.match(stack.text, /Body: Use a focused fixture/);

    const reddit = fromFetchResult(fetched(JSON.stringify([{
        data: {
            children: [{
                data: {
                    title: 'Thread title',
                    subreddit_name_prefixed: 'r/test',
                    author: 'bob',
                    score: 5,
                    num_comments: 3,
                    selftext: 'Post body',
                },
            }],
        },
    }])), { source: 'public_endpoint', label: 'reddit-json' });
    assert.match(reddit.text, /Reddit: Thread title/);
    assert.match(reddit.text, /Subreddit: r\/test/);
});

test('public endpoint normalizers convert academic and archive APIs into readable evidence', () => {
    const arxivXml = `<?xml version="1.0"?><feed><title>ignored feed</title><entry><id>https://arxiv.org/abs/2402.03300</id><title>Agent Paper</title><summary>Paper summary.</summary><published>2024-02-01</published><author><name>Alice</name></author><author><name>Bob</name></author></entry></feed>`;
    const arxiv = fromFetchResult(fetched(arxivXml, 'application/atom+xml'), { source: 'public_endpoint', label: 'arxiv-api' });
    assert.match(arxiv.text, /arXiv: Agent Paper/);
    assert.match(arxiv.text, /Authors: Alice, Bob/);
    assert.match(arxiv.text, /Summary: Paper summary/);

    const crossref = fromFetchResult(fetched(JSON.stringify({
        message: {
            DOI: '10.1000/example',
            title: ['Example DOI'],
            publisher: 'Publisher',
            'container-title': ['Journal'],
            'published-online': { 'date-parts': [[2024, 1, 2]] },
            URL: 'https://doi.org/10.1000/example',
        },
    })), { source: 'public_endpoint', label: 'crossref-work-api' });
    assert.match(crossref.text, /CrossRef: Example DOI/);
    assert.match(crossref.text, /Published: 2024-1-2/);

    const wayback = fromFetchResult(fetched(JSON.stringify([
        ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'],
        ['20200101000000', 'https://example.com/a', '200', 'text/html', 'abc'],
    ])), { source: 'public_endpoint', label: 'wayback-cdx-api' });
    assert.match(wayback.text, /Wayback captures/);
    assert.match(wayback.text, /20200101000000 200 text\/html https:\/\/example\.com\/a/);
});

test('public endpoint normalizers convert social and media APIs into readable evidence', () => {
    const bluesky = fromFetchResult(fetched(JSON.stringify({
        post: {
            uri: 'at://alice/app.bsky.feed.post/1',
            author: { handle: 'alice.example', displayName: 'Alice' },
            record: { text: 'Hello from Bluesky' },
            replyCount: 1,
            repostCount: 2,
            likeCount: 3,
        },
    })), { source: 'public_endpoint', label: 'bluesky-post-thread' });
    assert.match(bluesky.text, /Bluesky: Alice: Hello from Bluesky/);
    assert.match(bluesky.text, /Likes: 3/);

    const mastodon = fromFetchResult(fetched(JSON.stringify({
        id: '1',
        account: { acct: 'alice@example.social', display_name: 'Alice' },
        content: '<p>Hello Mastodon</p>',
        created_at: '2026-06-23T00:00:00Z',
        reblogs_count: 4,
        favourites_count: 5,
    })), { source: 'public_endpoint', label: 'mastodon-status-api' });
    assert.match(mastodon.text, /Mastodon: Alice/);
    assert.match(mastodon.text, /Text: Hello Mastodon/);

    const oembed = fromFetchResult(fetched(JSON.stringify({
        title: 'Video title',
        author_name: 'Creator',
        provider_name: 'YouTube',
        type: 'video',
        html: '<iframe title="Video title"></iframe>',
    })), { source: 'public_endpoint', label: 'youtube-oembed' });
    assert.match(oembed.text, /oEmbed: Video title/);
    assert.match(oembed.text, /Provider: YouTube/);
});

test('public endpoint normalizers convert RSS, Atom, and JSON Feed items into bounded evidence', () => {
    const rss = fromFetchResult(fetched(`
        <rss><channel>
          <title>Release Feed</title><link>https://example.com</link>
          <item><title>First release</title><pubDate>Tue, 23 Jun 2026 00:00:00 GMT</pubDate><link>https://example.com/1</link><description>First summary</description></item>
          <item><title>Second release</title><pubDate>Mon, 22 Jun 2026 00:00:00 GMT</pubDate><link>https://example.com/2</link><description>Second summary</description></item>
        </channel></rss>
    `, 'application/rss+xml'), { source: 'public_endpoint', label: 'rss-atom-discovered' });
    assert.match(rss.text, /Feed: Release Feed/);
    assert.match(rss.text, /Item 1: First release/);
    assert.match(rss.text, /URL: https:\/\/example\.com\/1/);
    assert.match(rss.text, /Item 2: Second release/);

    const atom = fromFetchResult(fetched(`
        <feed><title>Atom Feed</title><link href="https://atom.example"/>
          <entry><title>Atom entry</title><updated>2026-06-23T00:00:00Z</updated><link href="https://atom.example/e1"/><summary>Atom summary</summary></entry>
        </feed>
    `, 'application/atom+xml'), { source: 'public_endpoint', label: 'rss-atom-discovered' });
    assert.match(atom.text, /Feed: Atom Feed/);
    assert.match(atom.text, /Item 1: Atom entry/);
    assert.match(atom.text, /Date: 2026-06-23T00:00:00Z/);
    assert.match(atom.text, /URL: https:\/\/atom\.example\/e1/);
    assert.match(atom.text, /Summary: Atom summary/);

    const jsonFeed = fromFetchResult(fetched(JSON.stringify({
        title: 'JSON Feed',
        home_page_url: 'https://json.example',
        items: [{
            title: 'JSON entry',
            date_published: '2026-06-23T01:00:00Z',
            url: 'https://json.example/e1',
            summary: 'JSON summary',
        }],
    })), { source: 'public_endpoint', label: 'rss-atom-discovered' });
    assert.match(jsonFeed.text, /Feed: JSON Feed/);
    assert.match(jsonFeed.text, /Item 1: JSON entry/);
    assert.match(jsonFeed.text, /Date: 2026-06-23T01:00:00Z/);
    assert.match(jsonFeed.text, /URL: https:\/\/json\.example\/e1/);
    assert.ok(!jsonFeed.text.includes('"items"'), 'feed reader should not expose raw JSON as primary text');
});

test('unsupported public endpoint JSON falls back to generic text handling', () => {
    const generic = fromFetchResult(fetched(JSON.stringify({ hello: 'world' })), {
        source: 'public_endpoint',
        label: 'unknown-public-json',
    });
    assert.equal(generic.label, 'unknown-public-json');
    assert.equal(generic.title, '');
    assert.match(generic.text, /"hello":"world"/);
});

test('browser network JSON candidates reuse public endpoint readers for known API URLs', () => {
    const npm = fromNetworkCandidate({
        ...fetched(JSON.stringify({
            name: 'cli-jaw',
            version: '2.2.0',
            description: 'Agent runtime',
            'dist-tags': { latest: '2.2.0' },
        })),
        finalUrl: 'https://registry.npmjs.org/cli-jaw/latest',
        evidence: ['browser-network-json'],
    });
    assert.equal(npm.source, 'public_endpoint');
    assert.equal(npm.label, 'npm-registry-latest');
    assert.match(npm.text, /Package: cli-jaw@2\.2\.0/);
    assert.ok(npm.evidence.includes('public-endpoint:npm-registry-latest'));

    const hn = fromNetworkCandidate({
        ...fetched(JSON.stringify({
            id: 456,
            title: 'Network HN',
            by: 'carol',
            score: 11,
            descendants: 4,
        })),
        finalUrl: 'https://hacker-news.firebaseio.com/v0/item/456.json',
        evidence: ['browser-network-json'],
    });
    assert.equal(hn.label, 'hacker-news-item-api');
    assert.match(hn.text, /Hacker News: Network HN/);

    const github = fromNetworkCandidate({
        ...fetched(JSON.stringify({
            full_name: 'lidge-ai/cli-jaw',
            description: 'CLI Jaw',
            default_branch: 'dev',
            stargazers_count: 10,
            forks_count: 2,
            open_issues_count: 1,
            html_url: 'https://github.com/lidge-ai/cli-jaw',
        })),
        finalUrl: 'https://api.github.com/repos/lidge-ai/cli-jaw',
        evidence: ['browser-network-json'],
    });
    assert.equal(github.label, 'github-repo-api');
    assert.match(github.text, /Repository: lidge-ai\/cli-jaw/);
});

test('ordinary browser network JSON candidates keep generic network API behavior', () => {
    const generic = fromNetworkCandidate({
        ...fetched(JSON.stringify({ hello: 'world' })),
        finalUrl: 'https://app.example.test/api/bootstrap',
        evidence: ['browser-network-json'],
    });
    assert.equal(generic.source, 'network_api');
    assert.equal(generic.label, 'network_api');
    assert.match(generic.text, /"hello":"world"/);
    assert.ok(!generic.evidence.some(item => item.startsWith('public-endpoint:')));
});
