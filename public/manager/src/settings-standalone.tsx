import { createRoot } from 'react-dom/client';
import { SettingsPage } from './settings/SettingsPage';
import { createSettingsClient } from './settings/settings-client';
import type { SettingsClient } from './settings/types';
import { getAuthToken } from '../../js/api.js';
import './manager-tokens.css';
import './styles.css';
import './manager-dashboard-settings.css';
import './settings-shell.css';
import './settings-controls.css';
import './settings-agent.css';
import './settings-surface.css';
import './settings-embedding.css';

const proxyMatch = location.pathname.match(/^\/i\/(\d+)\//);
const apiBase = proxyMatch ? `/i/${proxyMatch[1]}` : '';
const host = document.getElementById('settings-root');
if (!host) throw new Error('Invalid settings host');

function validPort(value: unknown): number | null {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function applyTheme(theme: unknown): void {
    if (theme === 'dark' || theme === 'light' || theme === 'auto') document.documentElement.dataset['theme'] = theme;
}

if (parent !== window) {
    try {
        if (parent.location.origin === location.origin) applyTheme(parent.document.documentElement.dataset['theme']);
    } catch { /* Cross-origin hosts cannot supply the initial theme. */ }
}
const themeListener = (event: MessageEvent): void => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'jaw-preview-theme-sync') applyTheme(event.data.theme);
    if (event.data?.type === 'settings:request-back') {
        const back = host.querySelector<HTMLButtonElement>('.settings-back');
        if (back) back.click();
        else parent.postMessage({ type: 'settings:back' }, location.origin);
    }
};
window.addEventListener('message', themeListener);

// The optional extensions let this entry compile against the wp3 Shell/client;
// wp4 supplies the direct transport and instance-only navigation implementations.
const createDirectClient: (port: number, options?: {
    base?: string; getHeaders?: () => Promise<Record<string, string>>;
}) => SettingsClient = createSettingsClient;
const client = createDirectClient(0, { base: apiBase, getHeaders: async () => {
    const token = await getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
} });
let snapshot: { port?: unknown } | null = null;
// There used to be a `window.__JAW_PORT` bootstrap fast path here. Nothing in the tree ever
// assigned it, so it always resolved to null and this fetch ran regardless; keeping it implied
// a handshake that did not exist.
try {
    const result = await client.get<{ port?: unknown; data?: { port?: unknown } }>('/api/settings');
    snapshot = result.data ?? result;
} catch { /* Location is the final fallback; pages report their own API failures. */ }
const port = validPort(snapshot?.port) ?? validPort(location.port);
if (port === null) {
    host.setAttribute('role', 'alert');
    host.textContent = 'Cannot resolve instance settings port';
    throw new Error('Cannot resolve instance settings port');
}
let dirty = false;
const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
};
window.addEventListener('beforeunload', beforeUnload);
const standaloneProps: { scopes?: Array<'instance'>; client?: SettingsClient } = { scopes: ['instance'], client };
const root = createRoot(host);
let revision = 0;
const requestBack = (): void => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    if (dirty) { revision++; renderSettings(); }
    if (parent !== window) parent.postMessage({ type: 'settings:back' }, location.origin);
};
function renderSettings(): void {
    root.render(<SettingsPage key={revision} onBack={requestBack} port={port} instanceUrl={location.origin + apiBase} {...standaloneProps}
        onDirtyChange={value => { dirty = value; }}
        onSaved={() => { if (parent !== window) parent.postMessage({ type: 'jaw-settings-saved' }, location.origin); }} />);
}
renderSettings();
if (parent !== window) parent.postMessage({ type: 'jaw-settings-ready' }, location.origin);
if (import.meta.hot) import.meta.hot.dispose(() => {
    root.unmount();
    window.removeEventListener('message', themeListener);
    window.removeEventListener('beforeunload', beforeUnload);
});
