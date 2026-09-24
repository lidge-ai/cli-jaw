type BadgeNavigator = Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

const COMPLETION_DEDUPE_MS = 800;
const BADGE_SIZE = 64;
const BASE_TITLE_FALLBACK = 'CLI-JAW';
const MASCOT_FAVICON_SRC = '/icons/favicon-32.png';
const MASCOT_FALLBACK_COLOR = '#22d3ee';

let initialized = false;
let unreadCount = 0;
let baseTitle = BASE_TITLE_FALLBACK;
let faviconLink: HTMLLinkElement | null = null;
let originalFaviconHref = '';
let createdFaviconLink = false;
let lastNotifyAt = 0;
let mascotImage: HTMLImageElement | null = null;

function getBadgeNavigator(): BadgeNavigator {
    return navigator as BadgeNavigator;
}

function shouldCountUnread(): boolean {
    return document.visibilityState !== 'visible' || !document.hasFocus();
}

function isDuplicateCompletion(now: number): boolean {
    return now - lastNotifyAt < COMPLETION_DEDUPE_MS;
}

function getOrCreateFaviconLink(): HTMLLinkElement | null {
    if (faviconLink) return faviconLink;
    const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (existing) {
        faviconLink = existing;
        originalFaviconHref = existing.href || existing.getAttribute('href') || '';
        return existing;
    }
    const link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
    faviconLink = link;
    createdFaviconLink = true;
    return link;
}

function ensureMascotImage(): void {
    if (mascotImage) return;
    const img = new Image();
    img.addEventListener('load', () => {
        if (unreadCount > 0) applyUnreadState();
    });
    img.src = MASCOT_FAVICON_SRC;
    mascotImage = img;
}

function renderBadgeFavicon(count: number): string {
    const canvas = document.createElement('canvas');
    canvas.width = BADGE_SIZE;
    canvas.height = BADGE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalFaviconHref;

    ctx.clearRect(0, 0, BADGE_SIZE, BADGE_SIZE);
    if (mascotImage && mascotImage.complete && mascotImage.naturalWidth > 0) {
        ctx.drawImage(mascotImage, 2, 6, 52, 52);
    } else {
        ctx.beginPath();
        ctx.arc(28, 32, 26, 0, Math.PI * 2);
        ctx.fillStyle = MASCOT_FALLBACK_COLOR;
        ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(50, 15, count > 1 ? 12 : 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ff335f';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    if (count > 1) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.min(count, 9)), 50, 16);
    }

    return canvas.toDataURL('image/png');
}

async function setAppBadgeBestEffort(count: number): Promise<void> {
    const nav = getBadgeNavigator();
    if (typeof nav.setAppBadge !== 'function') return;
    try {
        await nav.setAppBadge(count);
    } catch {
        // Browser support varies; title/favicon remain the reliable baseline.
    }
}

async function clearAppBadgeBestEffort(): Promise<void> {
    const nav = getBadgeNavigator();
    if (typeof nav.clearAppBadge !== 'function') return;
    try {
        await nav.clearAppBadge();
    } catch {
        // Best-effort only.
    }
}

function applyUnreadState(): void {
    document.title = `(${unreadCount}) ${baseTitle}`;
    const link = getOrCreateFaviconLink();
    if (link) link.href = renderBadgeFavicon(unreadCount);
    void setAppBadgeBestEffort(unreadCount);
}

function restoreTitle(): void {
    document.title = baseTitle;
}

function restoreFavicon(): void {
    if (!faviconLink) return;
    if (createdFaviconLink) {
        faviconLink.remove();
        faviconLink = null;
        createdFaviconLink = false;
        return;
    }
    faviconLink.href = originalFaviconHref;
}

export function initAttentionBadge(): void {
    if (initialized) return;
    initialized = true;
    baseTitle = document.title || BASE_TITLE_FALLBACK;
    getOrCreateFaviconLink();
    ensureMascotImage();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') clearUnreadResponses();
    });
    window.addEventListener('focus', () => clearUnreadResponses());
}

export function notifyUnreadResponse(): void {
    if (!initialized || !shouldCountUnread()) return;
    const now = Date.now();
    if (isDuplicateCompletion(now)) return;
    lastNotifyAt = now;
    unreadCount += 1;
    applyUnreadState();
}

export function clearUnreadResponses(): void {
    if (!initialized || unreadCount === 0) return;
    unreadCount = 0;
    lastNotifyAt = 0;
    restoreTitle();
    restoreFavicon();
    void clearAppBadgeBestEffort();
}

export function getUnreadResponseCount(): number {
    return unreadCount;
}
