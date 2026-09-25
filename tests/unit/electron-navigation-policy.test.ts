import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildManagerCsp,
    buildPreviewFrameOrigins,
    externalOpenUrlForNavigation,
    isAppInternalNavigation,
    isManagerNavigation,
    isPreviewFrameNavigation,
    normalizeExternalOpenUrl,
    resolvePreviewFramePolicy,
} from '../../electron/src/main/lib/navigation-policy.ts';

test('electron CSP allows loopback origin-port iframe previews', () => {
    const policy = { previewFrom: 24602, previewCount: 2 };
    const origins = buildPreviewFrameOrigins(policy);
    const csp = buildManagerCsp('http://127.0.0.1:24576', origins);

    assert.ok(csp.includes('frame-src'));
    assert.ok(csp.includes('child-src'));
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(csp.includes("'self'"));
    assert.ok(csp.includes('http:'));
    assert.ok(csp.includes('https:'));
    assert.ok(csp.includes('http://127.0.0.1:24602'));
    assert.ok(csp.includes('http://localhost:24603'));
    assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false);
    assert.equal(csp.includes('http://example.com'), false);
});

test('electron frame navigation allows only manager or configured loopback preview ports', () => {
    const policy = { previewFrom: 24602, previewCount: 50 };

    assert.equal(isManagerNavigation('http://127.0.0.1:24576/', 'http://127.0.0.1:24576'), true);
    assert.equal(isPreviewFrameNavigation('http://127.0.0.1:24602/', policy), true);
    assert.equal(isPreviewFrameNavigation('http://localhost:24651/', policy), true);
    assert.equal(isPreviewFrameNavigation('http://127.0.0.1:24652/', policy), false);
    assert.equal(isPreviewFrameNavigation('https://127.0.0.1:24602/', policy), false);
    assert.equal(isPreviewFrameNavigation('http://example.com:24602/', policy), false);
});

test('electron preview frame policy follows dashboard preview env with capped count', () => {
    const policy = resolvePreviewFramePolicy({
        DASHBOARD_PREVIEW_FROM: '25000',
        DASHBOARD_SCAN_COUNT: '999',
    });

    assert.deepEqual(policy, { previewFrom: 25000, previewCount: 200 });
});

test('electron external open policy keeps app origins internal and opens safe web URLs', () => {
    const options = {
        managerOrigin: 'http://127.0.0.1:24576',
        previewFrom: 24602,
        previewCount: 50,
    };

    assert.equal(normalizeExternalOpenUrl('https://example.com/docs'), 'https://example.com/docs');
    assert.equal(normalizeExternalOpenUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
    assert.equal(normalizeExternalOpenUrl('javascript:alert(1)'), null);
    assert.equal(normalizeExternalOpenUrl('https://user:pass@example.com/'), null);
    assert.equal(isAppInternalNavigation('http://127.0.0.1:24576/manager', options), true);
    assert.equal(isAppInternalNavigation('http://127.0.0.1:24602/', options), true);
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:24576/manager', options), null);
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:24602/', options), null);
    assert.equal(externalOpenUrlForNavigation('https://github.com/lidge-ai/cli-jaw', options), 'https://github.com/lidge-ai/cli-jaw');
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:3000/', options), 'http://127.0.0.1:3000/');
});
