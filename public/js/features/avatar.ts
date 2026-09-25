import { escapeHtml } from '../render.js';
import { api, getAuthToken } from '../api.js';
import { ICONS } from '../icons.js';

type AvatarRole = 'agent' | 'user';
type AvatarServerEntry = {
    kind?: 'emoji' | 'image';
    imageUrl?: string;
    updatedAt?: number | null;
};
type AvatarServerState = Record<AvatarRole, AvatarServerEntry>;
type AvatarState = {
    emoji: string;
    imageUrl: string;
    updatedAt: number | null;
};

const AGENT_KEY = 'agentAvatar';
const USER_KEY = 'userAvatar';
// Front-facing mascot mark (transparent PNG) — kept as markup so avatarMarkup can
// render it exactly like the stored SVG/emoji defaults.
const DEFAULT_AGENT = '<img class="avatar-mascot" src="/icons/mascot.png" alt="" aria-hidden="true">';
const DEFAULT_USER = ICONS.user;

const avatarState: Record<AvatarRole, AvatarState> = {
    agent: { emoji: DEFAULT_AGENT, imageUrl: '', updatedAt: null },
    user: { emoji: DEFAULT_USER, imageUrl: '', updatedAt: null },
};

let initialized = false;

function stateFor(role: AvatarRole): AvatarState {
    return avatarState[role];
}

function storageKey(role: AvatarRole): string {
    return role === 'agent' ? AGENT_KEY : USER_KEY;
}

function inputId(_role: AvatarRole): string {
    return _role === 'agent' ? 'agentAvatarPreview' : 'userAvatarPreview';
}

function iconSelector(role: AvatarRole): string {
    return role === 'agent' ? '.agent-icon' : '.user-icon';
}

function syncPreview(role: AvatarRole): void {
    const preview = document.getElementById(inputId(role));
    if (preview) {
        preview.innerHTML = avatarMarkup(role);
        const kind = stateFor(role).imageUrl ? 'image' : 'emoji';
        preview.setAttribute('data-avatar-kind', kind);
    }
}

function avatarMarkup(role: AvatarRole): string {
    const current = stateFor(role);
    if (current.imageUrl) {
        return `<img class="avatar-image" src="${escapeHtml(current.imageUrl)}" alt="" loading="lazy" decoding="async">`;
    }
    // Default avatars are markup (Lucide SVG, emoji, or the mascot image) — render as-is
    return current.emoji;
}

function applyAvatar(role: AvatarRole): void {
    const html = avatarMarkup(role);
    const kind = stateFor(role).imageUrl ? 'image' : 'emoji';
    document.querySelectorAll(iconSelector(role)).forEach((el) => {
        el.innerHTML = html;
        el.setAttribute('data-avatar-kind', kind);
    });
}

function setServerAvatar(role: AvatarRole, payload?: AvatarServerEntry | null): void {
    if (payload?.kind === 'image' && payload.imageUrl) {
        stateFor(role).imageUrl = payload.imageUrl;
        stateFor(role).updatedAt = payload.updatedAt ?? Date.now();
    } else {
        stateFor(role).imageUrl = '';
        stateFor(role).updatedAt = payload?.updatedAt ?? null;
    }
    syncPreview(role);
    applyAvatar(role);
}

async function loadServerAvatars(): Promise<void> {
    const payload = await api<AvatarServerState>('/api/avatar');
    if (!payload) return;
    setServerAvatar('agent', payload.agent);
    setServerAvatar('user', payload.user);
}

async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    const token = await getAuthToken();
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(path, { ...init, headers });
}

async function uploadAvatar(role: AvatarRole, file: File): Promise<void> {
    const res = await authorizedFetch(`/api/avatar/${role}/upload`, {
        method: 'POST',
        headers: {
            'Content-Type': file.type || 'image/png',
            'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `avatar upload failed (${res.status})`);
    setServerAvatar(role, json?.data || json);
}

async function resetAvatarImage(role: AvatarRole): Promise<void> {
    const res = await authorizedFetch(`/api/avatar/${role}/image`, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `avatar reset failed (${res.status})`);
    setServerAvatar(role, json?.data || json);
}

function bindRoleControls(role: AvatarRole): void {
    const uploadBtnId = role === 'agent' ? 'agentAvatarUploadBtn' : 'userAvatarUploadBtn';
    const resetBtnId = role === 'agent' ? 'agentAvatarResetBtn' : 'userAvatarResetBtn';
    const fileInputId = role === 'agent' ? 'agentAvatarFile' : 'userAvatarFile';

    document.getElementById(uploadBtnId)?.addEventListener('click', () => {
        (document.getElementById(fileInputId) as HTMLInputElement | null)?.click();
    });

    document.getElementById(resetBtnId)?.addEventListener('click', async () => {
        try {
            await resetAvatarImage(role);
        } catch (error) {
            console.warn('[avatar:reset]', (error as Error).message);
        }
    });

    document.getElementById(fileInputId)?.addEventListener('change', async (event: Event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        try {
            await uploadAvatar(role, file);
        } catch (error) {
            console.warn('[avatar:upload]', (error as Error).message);
        } finally {
            input.value = '';
        }
    });
}

export function getAgentAvatar(): string { return stateFor('agent').emoji; }
export function getUserAvatar(): string { return stateFor('user').emoji; }
export function getAgentAvatarMarkup(): string { return avatarMarkup('agent'); }
export function getUserAvatarMarkup(): string { return avatarMarkup('user'); }

export function setAgentAvatar(emoji: string): void {
    const next = (emoji || '').trim() || DEFAULT_AGENT;
    stateFor('agent').emoji = next;
    localStorage.setItem(storageKey('agent'), next);
    syncPreview('agent');
    if (!stateFor('agent').imageUrl) applyAvatar('agent');
}

export function setUserAvatar(emoji: string): void {
    const next = (emoji || '').trim() || DEFAULT_USER;
    stateFor('user').emoji = next;
    localStorage.setItem(storageKey('user'), next);
    syncPreview('user');
    if (!stateFor('user').imageUrl) applyAvatar('user');
}

export async function initAvatar(): Promise<void> {
    stateFor('agent').emoji = localStorage.getItem(AGENT_KEY) || DEFAULT_AGENT;
    stateFor('user').emoji = localStorage.getItem(USER_KEY) || DEFAULT_USER;
    syncPreview('agent');
    syncPreview('user');

    if (!initialized) {
        initialized = true;
        bindRoleControls('agent');
        bindRoleControls('user');
    }

    await loadServerAvatars();
    applyAvatar('agent');
    applyAvatar('user');
}
