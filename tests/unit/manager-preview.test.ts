import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPreviewDesktop, appendPreviewTheme, buildPreviewState, normalizePreviewUrlForCurrentHost } from '../../public/manager/src/preview.js';
import type { DashboardInstance, DashboardScanResult } from '../../public/manager/src/types.js';

const online: DashboardInstance = {
    port: 3457,
    url: 'http://localhost:3457',
    status: 'online',
    ok: true,
    version: null,
    uptime: null,
    instanceId: 'default',
    homeDisplay: '/Users/jun/.cli-jaw',
    workingDir: '/Users/jun/.cli-jaw',
    currentCli: 'codex',
    currentModel: null,
    serviceMode: 'unknown',
    lastCheckedAt: '2026-04-26T00:00:00.000Z',
    healthReason: null,
};

const data: DashboardScanResult = {
    manager: {
        port: 24576,
        rangeFrom: 3457,
        rangeTo: 3506,
        checkedAt: '2026-04-26T00:00:00.000Z',
        proxy: {
            enabled: true,
            basePath: '/i',
            allowedFrom: 3457,
            allowedTo: 3506,
        },
    },
    instances: [online],
};

test('preview helper builds proxy preview url', () => {
    assert.deepEqual(buildPreviewState(online, data, 'proxy'), {
        canPreview: true,
        src: '/i/3457/0',
        reason: null,
        transport: 'legacy-path',
        warning: 'legacy proxy fallback',
    });
});

test('preview helper appends theme to proxy preview url', () => {
    const state = buildPreviewState(online, data, 'dark');

    assert.equal(state.src, '/i/3457/0?jawTheme=dark');
    assert.equal(state.transport, 'legacy-path');
});

test('preview helper preserves query and hash when appending theme', () => {
    assert.equal(appendPreviewTheme('/i/3457/?existing=1#top', 'light'), '/i/3457/?existing=1&jawTheme=light#top');
});

test('preview helper appends desktop marker for the Electron shell', () => {
    const state = buildPreviewState(online, data, { desktop: true });

    assert.equal(state.src, '/i/3457/0?jawDesktop=1');
    assert.equal(state.transport, 'legacy-path');
});

test('preview helper combines desktop marker with theme', () => {
    const state = buildPreviewState(online, data, { theme: 'dark', desktop: true });

    assert.equal(state.src, '/i/3457/0?jawTheme=dark&jawDesktop=1');
});

test('preview helper preserves query when appending desktop marker', () => {
    assert.equal(appendPreviewDesktop('/i/3457/?existing=1', true), '/i/3457/?existing=1&jawDesktop=1');
    assert.equal(appendPreviewDesktop('/i/3457/0', false), '/i/3457/0');
});

test('preview helper prefers origin-port preview url', () => {
    assert.deepEqual(buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
                preview: {
                    enabled: true,
                    kind: 'origin-port',
                    previewFrom: 24602,
                    previewTo: 24651,
                    instances: {
                        '3457': {
                            targetPort: 3457,
                            previewPort: 24602,
                            url: 'http://127.0.0.1:24602/',
                            status: 'ready',
                            reason: null,
                        },
                    },
                },
            },
        },
    }), {
        canPreview: true,
        src: 'http://127.0.0.1:24602/0',
        reason: null,
        transport: 'origin-port',
        warning: 'origin proxy ready',
    });
});

test('preview helper appends theme to origin-port preview url', () => {
    const state = buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
                preview: {
                    enabled: true,
                    kind: 'origin-port',
                    previewFrom: 24602,
                    previewTo: 24651,
                    instances: {
                        '3457': {
                            targetPort: 3457,
                            previewPort: 24602,
                            url: 'http://127.0.0.1:24602/?x=1#frame',
                            status: 'ready',
                            reason: null,
                        },
                    },
                },
            },
        },
    }, 'light');

    assert.equal(state.src, 'http://127.0.0.1:24602/0?x=1&jawTheme=light#frame');
    assert.equal(state.transport, 'origin-port');
});

test('preview helper can force same-origin proxy as an explicit fallback', () => {
    const state = buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
                preview: {
                    enabled: true,
                    kind: 'origin-port',
                    previewFrom: 24602,
                    previewTo: 24651,
                    instances: {
                        '3457': {
                            targetPort: 3457,
                            previewPort: 24602,
                            url: 'http://127.0.0.1:24602/',
                            status: 'ready',
                            reason: null,
                        },
                    },
                },
            },
        },
    }, { theme: 'light', transport: 'legacy-path' });

    assert.equal(state.src, '/i/3457/0?jawTheme=light');
    assert.equal(state.transport, 'legacy-path');
});

test('preview helper rewrites loopback origin preview host to current dashboard host', () => {
    assert.equal(
        normalizePreviewUrlForCurrentHost('http://127.0.0.1:24602/?x=1', 'http://localhost:24576/'),
        'http://localhost:24602/?x=1',
    );
    assert.equal(
        normalizePreviewUrlForCurrentHost('http://127.0.0.1:24602/', 'http://example.com:24576/'),
        'http://127.0.0.1:24602/',
    );
});

test('preview helper falls back when origin-port preview is unavailable', () => {
    const state = buildPreviewState(online, {
        ...data,
        manager: {
            ...data.manager,
            proxy: {
                ...data.manager.proxy,
                preview: {
                    enabled: true,
                    kind: 'origin-port',
                    previewFrom: 24602,
                    previewTo: 24651,
                    instances: {
                        '3457': {
                            targetPort: 3457,
                            previewPort: 24602,
                            url: 'http://127.0.0.1:24602/',
                            status: 'unavailable',
                            reason: 'EADDRINUSE',
                        },
                    },
                },
            },
        },
    });

    assert.equal(state.src, '/i/3457/0');
    assert.equal(state.transport, 'legacy-path');
});

test('preview helper ignores legacy direct mode argument and keeps proxy path', () => {
    const state = buildPreviewState(online, data, 'direct' as any);

    assert.equal(state.src, '/i/3457/0');
    assert.equal(state.transport, 'legacy-path');
    assert.equal(state.warning, 'legacy proxy fallback');
});

test('preview helper rejects offline instances', () => {
    const offline: DashboardInstance = { ...online, ok: false, status: 'offline' };
    const state = buildPreviewState(offline, data, 'proxy');

    assert.equal(state.canPreview, false);
    assert.match(state.reason || '', /online/);
    assert.equal(state.transport, 'none');
});

function originScan(base: string): DashboardScanResult {
    const scan = structuredClone(data);
    assert.ok(scan.manager.proxy);
    scan.manager.proxy.preview = {
        enabled: true, kind: 'origin-port', previewFrom: 24602, previewTo: 24651,
        instances: {
            '3457': { targetPort: 3457, previewPort: 24602, url: `${base}?x=1#frame`, status: 'ready', reason: null },
        },
    };
    return scan;
}

test('default-session preview handles origin bases with or without a trailing slash', () => {
    for (const base of ['http://127.0.0.1:24602', 'http://127.0.0.1:24602/']) {
        assert.equal(buildPreviewState(online, originScan(base), 'light').src,
            'http://127.0.0.1:24602/0?x=1&jawTheme=light#frame');
    }
});

test('default-session preview normalizes localhost and respects Safari and explicit legacy transport', async () => {
    const { setupWebUiDom, resetWebUiDom } = await import('./web-ui-test-dom.ts');
    const globals = Object.getOwnPropertyDescriptors(globalThis);
    try {
        setupWebUiDom();
        // The common DOM fixture uses 127.0.0.1; use a real localhost location
        // without attempting cross-origin history mutation in JSDOM.
        const { JSDOM } = await import('jsdom');
        const localDom = new JSDOM('', { url: 'http://localhost:24576/' });
        try {
            Object.defineProperty(globalThis, 'window', { configurable: true, value: localDom.window });
            const scan = originScan('http://127.0.0.1:24602/');
            assert.equal(buildPreviewState(online, scan, 'light').src,
                'http://localhost:24602/0?x=1&jawTheme=light#frame');
            assert.equal(buildPreviewState(online, scan, { transport: 'legacy-path' }).src, '/i/3457/0');
            Object.defineProperty(globalThis, 'navigator', {
                configurable: true, value: { userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15' },
            });
            const safari = buildPreviewState(online, scan);
            assert.equal(safari.src, '/i/3457/0');
            assert.equal(safari.transport, 'legacy-path');
        } finally { localDom.window.close(); }
    } finally {
        resetWebUiDom();
        for (const key of Object.getOwnPropertyNames(globalThis)) {
            if (!(key in globals)) Reflect.deleteProperty(globalThis, key);
        }
        Object.defineProperties(globalThis, globals);
    }
});

test('default-session navigation preserves all preview eligibility guards', () => {
    const disabled = structuredClone(data);
    assert.ok(disabled.manager.proxy);
    disabled.manager.proxy.enabled = false;
    for (const [instance, scan] of [
        [null, data], [{ ...online, ok: false, status: 'offline' }, data],
        [online, disabled], [{ ...online, port: 3507 }, data],
    ] as Array<[DashboardInstance | null, DashboardScanResult]>) {
        const state = buildPreviewState(instance, scan);
        assert.equal(state.canPreview, false);
        assert.equal(state.src, null);
        assert.equal(state.transport, 'none');
    }
});
