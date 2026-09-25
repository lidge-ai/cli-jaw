import type { DashboardInstance, DashboardScanResult } from './types';

export type PreviewState = {
    canPreview: boolean;
    src: string | null;
    reason: string | null;
    transport: PreviewTransport;
    warning: string | null;
};

export type PreviewTheme = 'dark' | 'light';
export type PreviewTransport = 'origin-port' | 'legacy-path' | 'none';
export type PreviewTransportPreference = 'origin-port' | 'legacy-path';

type PreviewArgument =
    | PreviewTheme
    | 'proxy'
    | 'direct'
    | {
        theme?: PreviewTheme | null;
        transport?: PreviewTransportPreference | null;
        /** True when the preview renders inside the Electron desktop shell. */
        desktop?: boolean | null;
    }
    | undefined;

function isLoopbackHost(hostname: string): boolean {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** Safari dashboard iframe fails intermittently on dedicated preview origins (ITP + cross-origin). */
export function prefersLegacyPreviewTransport(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
    return /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(userAgent);
}

function isPreviewTheme(value: PreviewArgument): value is PreviewTheme {
    return value === 'dark' || value === 'light';
}

function resolvePreviewArgument(value: PreviewArgument): { theme: PreviewTheme | null; transport: PreviewTransportPreference | null; desktop: boolean } {
    if (value && typeof value === 'object') {
        const theme = value.theme === 'dark' || value.theme === 'light' ? value.theme : null;
        return {
            theme,
            transport: value.transport === 'legacy-path' || value.transport === 'origin-port' ? value.transport : null,
            desktop: value.desktop === true,
        };
    }
    return {
        theme: isPreviewTheme(value) ? value : null,
        transport: value === 'proxy' ? 'legacy-path' : null,
        desktop: false,
    };
}

export function normalizePreviewUrlForCurrentHost(src: string, currentHref?: string): string {
    const href = currentHref || (typeof window !== 'undefined' ? window.location.href : '');
    if (!href || src.startsWith('/')) return src;
    try {
        const previewUrl = new URL(src);
        const currentUrl = new URL(href);
        if (isLoopbackHost(previewUrl.hostname) && isLoopbackHost(currentUrl.hostname)) {
            previewUrl.hostname = currentUrl.hostname;
        }
        return previewUrl.toString();
    } catch {
        return src;
    }
}

export function appendPreviewTheme(src: string, theme: PreviewTheme | null | undefined): string {
    if (!theme) return src;
    const isRelative = src.startsWith('/');
    const url = new URL(src, 'http://jaw.local');
    url.searchParams.set('jawTheme', theme);
    if (isRelative) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
}

/** Marks preview URLs loaded inside the desktop shell so the framed page can
 * apply desktop chrome (titlebar-inset topbar height) without a preload. */
export function appendPreviewDesktop(src: string, desktop: boolean): string {
    if (!desktop) return src;
    const isRelative = src.startsWith('/');
    const url = new URL(src, 'http://jaw.local');
    url.searchParams.set('jawDesktop', '1');
    if (isRelative) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
}

export function buildPreviewState(
    instance: DashboardInstance | null,
    data: DashboardScanResult | null,
    previewArgument?: PreviewArgument,
): PreviewState {
    if (!instance) {
        return { canPreview: false, src: null, reason: 'Select an online instance to preview.', transport: 'none', warning: null };
    }

    if (!instance.ok) {
        return { canPreview: false, src: null, reason: 'Preview is only available for online instances.', transport: 'none', warning: null };
    }

    const proxy = data?.manager.proxy;
    if (!proxy?.enabled) {
        return { canPreview: false, src: null, reason: 'Proxy preview is not available.', transport: 'none', warning: null };
    }
    if (instance.port < proxy.allowedFrom || instance.port > proxy.allowedTo) {
        return { canPreview: false, src: null, reason: 'This port is outside the proxy allowlist.', transport: 'none', warning: null };
    }
    const originPreview = proxy.preview?.instances[String(instance.port)];
    const { theme, transport, desktop } = resolvePreviewArgument(previewArgument);
    const useOriginPort = transport !== 'legacy-path'
        && proxy.preview?.enabled
        && originPreview?.status === 'ready'
        && originPreview.url
        && !prefersLegacyPreviewTransport();
    if (useOriginPort) {
        const previewUrl = new URL(normalizePreviewUrlForCurrentHost(originPreview.url));
        previewUrl.pathname = `${previewUrl.pathname.replace(/\/?$/, '/')}0`;
        return {
            canPreview: true,
            src: appendPreviewDesktop(appendPreviewTheme(previewUrl.toString(), theme), desktop),
            reason: null,
            transport: 'origin-port',
            warning: 'origin proxy ready',
        };
    }
    const basePath = proxy.basePath || '/i';
    return {
        canPreview: true,
        src: appendPreviewDesktop(appendPreviewTheme(`${basePath}/${instance.port}/0`, theme), desktop),
        reason: null,
        transport: 'legacy-path',
        warning: 'legacy proxy fallback',
    };
}
