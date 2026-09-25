// Client-side OS detection for keyboard behavior and labels.
//
// This reads the browser or desktop window that receives the key events, never
// the server's process.platform: a dashboard served from a Mac can be opened from
// a Windows machine, and the keyboard in front of the user is what matters.

type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } };

export function currentClientPlatform(): string {
    if (typeof navigator === 'undefined') return '';
    const nav = navigator as NavigatorWithUserAgentData;
    return nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
}

export function isMacLikePlatform(platform: string = currentClientPlatform()): boolean {
    return /mac|iphone|ipad|ipod/i.test(platform);
}

