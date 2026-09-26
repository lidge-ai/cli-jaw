import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

function sliceBetween(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `${start} must exist`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `${end} must exist after ${start}`);
    return source.slice(from, to);
}

test('jaw-ceo frontend installs workbench launcher outside instance groups', async () => {
    const app = read('public/manager/src/App.tsx');
    const bridge = read('public/manager/src/jaw-ceo/useJawCeoDashboardBridge.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const list = read('public/manager/src/components/InstanceListContent.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(app.includes('useJawCeoDashboardBridge('), 'App must delegate Jaw CEO dashboard wiring to the bridge');
    assert.ok(bridge.includes('useJawCeo('), 'bridge must own the Jaw CEO dashboard hook');
    assert.ok(bridge.includes('<JawCeoWorkbenchButton'), 'bridge must render the Workbench CEO launcher');
    assert.ok(bridge.includes('const workbenchControlsHidden = true'), 'CEO workbench controls must stay hidden while the launcher is parked');
    assert.ok(bridge.includes('workbenchControlsHidden ? null : ('), 'bridge must remove the CEO launcher from the Workbench while parked');
    assert.ok(router.includes('<JawCeoConsole'), 'router must render the CEO console in the right panel or sidePanel slot');
    assert.ok(router.includes('jawCeoWorkbenchButton?: ReactNode'), 'router must accept a CEO Workbench button slot');
    assert.ok(workbench.includes('modeActions?: ReactNode'), 'Workbench must expose a tab-bar action slot');
    const React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
    const { JSDOM } = await import('jsdom');
    const { Workbench } = await import('../../public/manager/src/components/Workbench');
    const globals = globalThis as unknown as Record<string, unknown>, previous = globals['React']; globals['React'] = React;
    try {
        const actions = React.createElement(React.Fragment, null, React.createElement('button', { id: 'ceo-test' }, 'CEO'));
        const dom = new JSDOM(renderToStaticMarkup(React.createElement(Workbench, { mode: 'overview', active: true,
            onModeChange() {}, header: null, modeActions: actions, overview: null, preview: null, logs: null })));
        const tabs = dom.window.document.querySelector('.workbench-mode-tabs');
        assert.equal(tabs?.nextElementSibling?.id, 'ceo-test');
        assert.equal(tabs?.nextElementSibling?.nextElementSibling, null,
            'the mode bar carries the CEO button alone; the settings gear is retired');
        dom.window.close();
    } finally { globals['React'] = previous; }
    assert.equal(router.includes('jawCeoNavigatorContent'), false, 'CEO must not be injected into Navigator');
    assert.equal(list.includes('ceoPendingByPort'), false, 'instance list must not accept CEO pending counts by default');
    assert.equal(groups.includes('ceoWatchedPorts'), false, 'instance groups must not pass CEO watch state by default');
    assert.equal(row.includes('instance-row-ceo-flags'), false, 'instance rows must not show default CEO flags');
    assert.ok(main.includes('./jaw-ceo/jaw-ceo.css'), 'manager entry must load Jaw CEO CSS');
});

test('jaw-ceo workbench launcher can disable CEO ready and microphone controls', () => {
    const launcher = read('public/manager/src/jaw-ceo/JawCeoWorkbenchButton.tsx');
    const css = read('public/manager/src/jaw-ceo/jaw-ceo.css');

    assert.ok(launcher.includes('disabled?: boolean'), 'launcher must accept a disabled prop');
    assert.ok(launcher.includes("const status = disabled ? 'off'"), 'disabled CEO ready status must render as off');
    assert.ok(launcher.includes('disabled={disabled}'), 'CEO button must be disabled');
    assert.ok(launcher.includes('disabled={disabled || props.busy}'), 'microphone button must be disabled with the CEO control');
    assert.ok(css.includes('.jaw-ceo-workbench-launcher.is-disabled'), 'disabled launcher must have visible styling');
});

test('jaw-ceo frontend API keeps completions server-owned', () => {
    const api = read('public/manager/src/jaw-ceo/api.ts');
    const hook = read('public/manager/src/jaw-ceo/useJawCeo.ts');

    assert.ok(api.includes('/api/jaw-ceo/events/refresh'), 'frontend must request server-side completion refresh');
    assert.ok(api.includes('/api/jaw-ceo/pending'), 'frontend must read pending completions from the server');
    assert.ok(hook.includes('refreshJawCeoEvents({ events: freshEvents })'), 'hook must bridge manager message events to the server');
    assert.equal(hook.includes('completionKey: `'), false, 'frontend must not mint completion keys');
});

test('jaw-ceo frontend module file set stays explicit and bounded', () => {
    const files = [
        'public/manager/src/jaw-ceo/types.ts',
        'public/manager/src/jaw-ceo/api.ts',
        'public/manager/src/jaw-ceo/useJawCeo.ts',
        'public/manager/src/jaw-ceo/useJawCeoVirtualTimeline.ts',
        'public/manager/src/jaw-ceo/voice-session.ts',
        'public/manager/src/jaw-ceo/useJawCeoVoice.ts',
        'public/manager/src/jaw-ceo/voice-cues.ts',
        'public/manager/src/jaw-ceo/JawCeoWorkbenchButton.tsx',
        'public/manager/src/jaw-ceo/JawCeoConsole.tsx',
        'public/manager/src/jaw-ceo/JawCeoVoiceOverlay.tsx',
        'public/manager/src/jaw-ceo/JawCeoSettingsPanel.tsx',
        'public/manager/src/jaw-ceo/JawCeoTabs.tsx',
        'public/manager/src/jaw-ceo/jaw-ceo.css',
        'public/manager/src/jaw-ceo/jaw-ceo-console.css',
        'public/manager/src/jaw-ceo/jaw-ceo-virtual.css',
    ];

    for (const file of files) {
        assert.equal(existsSync(join(projectRoot, file)), true, `${file} must exist`);
        assert.ok(read(file).split('\n').length <= 500, `${file} must stay below 500 lines`);
    }
});

test('jaw-ceo frontend exposes masked voice key settings inside CEO console', () => {
    const api = read('public/manager/src/jaw-ceo/api.ts');
    const tabs = read('public/manager/src/jaw-ceo/JawCeoTabs.tsx');
    const panels = read('public/manager/src/jaw-ceo/JawCeoConsolePanels.tsx');
    const model = read('public/manager/src/jaw-ceo/useJawCeoConsoleModel.ts');
    const virtualHook = read('public/manager/src/jaw-ceo/useJawCeoVirtualTimeline.ts');
    const settings = read('public/manager/src/jaw-ceo/JawCeoSettingsPanel.tsx');

    assert.ok(api.includes('/api/jaw-ceo/settings'), 'frontend must use the Jaw CEO scoped settings endpoint');
    assert.ok(api.includes('updateJawCeoSettings'), 'frontend must be able to save a new voice API key');
    assert.ok(tabs.includes("{ id: 'settings', label: 'Settings' }"), 'CEO console must expose a Settings tab');
    assert.equal(tabs.includes("label: 'Pending'"), false, 'pending worker results must render inside Chat, not a separate tab');
    assert.equal(tabs.includes("label: 'Watched'"), false, 'watched workers must render inside Chat, not a separate tab');
    assert.equal(tabs.includes("label: 'Tools'"), false, 'tool use must render inside Chat, not a separate tab');
    assert.ok(panels.includes('<JawCeoSettingsPanel />'), 'settings tab must render the key settings panel');
    assert.ok(panels.includes('args.ceo.state.transcript'), 'chat timeline must hydrate from server-owned transcript');
    assert.ok(panels.includes('Array.isArray(args.ceo.state.transcript)'), 'chat timeline must tolerate older state responses before server restart');
    assert.equal(model.includes('useState<ChatEntry[]>'), false, 'chat transcript must not be local component state');
    assert.ok(virtualHook.includes("@tanstack/virtual-core"), 'CEO chat must use existing TanStack virtual-core dependency');
    assert.ok(virtualHook.includes('count: args.count'), 'virtualization must be active from item count zero');
    assert.ok(panels.includes('useJawCeoVirtualTimeline'), 'chat panel must render through the CEO virtual timeline hook');
    assert.equal(panels.includes('className="jaw-ceo-activity-group" open'), false, 'tool activity details must default collapsed');
    assert.ok(settings.includes('type="password"'), 'API key input must not be plain text');
    assert.equal(settings.includes('localStorage'), false, 'API key must not be stored in browser localStorage');
});

test('jaw-ceo frontend renders realtime voice overlay and silent state without iframe coupling', () => {
    const app = read('public/manager/src/App.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const bridge = read('public/manager/src/jaw-ceo/useJawCeoDashboardBridge.tsx');
    const hook = read('public/manager/src/jaw-ceo/useJawCeoVoice.ts');
    const overlay = read('public/manager/src/jaw-ceo/JawCeoVoiceOverlay.tsx');
    const cues = read('public/manager/src/jaw-ceo/voice-cues.ts');
    const consolePanel = read('public/manager/src/jaw-ceo/JawCeoConsole.tsx');
    const consolePanels = read('public/manager/src/jaw-ceo/JawCeoConsolePanels.tsx');
    const main = read('public/manager/src/main.tsx');
    const css = read('public/manager/src/jaw-ceo/jaw-ceo.css');
    const consoleCss = read('public/manager/src/jaw-ceo/jaw-ceo-console.css');
    const types = read('public/manager/src/jaw-ceo/types.ts');
    const stopBlock = sliceBetween(hook, 'const stop = useCallback(async () => {', 'const end = useCallback');
    const talkBlock = sliceBetween(hook, 'const talk = useCallback(async () => {', 'const sendText = useCallback');
    const hiddenCloseBlock = sliceBetween(hook, 'useEffect(() => {\n        if (args.documentVisible) return;', 'useEffect(() => {\n        if (status !==');
    const silentBlock = sliceBetween(hook, "if (status !== 'active' && status !== 'silent') return undefined;", 'void args.autoRead;');
    const overlayIndex = router.indexOf('{props.jawCeoVoiceOverlay}');
    const layoutIndex = router.indexOf('<WorkspaceLayout');
    const workspaceLayerIndex = router.indexOf('<div className="workspace-surface-layer">');

    assert.ok(types.includes("'silent'"), 'frontend voice status must include silent');
    assert.ok(types.includes("'paused'"), 'frontend voice status must include paused resume state');
    assert.ok(hook.includes('SILENT_STATE_AFTER_MS'), 'voice hook must define a silence transition threshold');
    assert.ok(hook.includes('response.audio_transcript.delta'), 'voice hook must parse realtime response transcript deltas');
    assert.ok(hook.includes('responseTranscriptRef'), 'voice hook must accumulate realtime response text before rendering it');
    assert.ok(hook.includes("setStatus('silent')"), 'voice hook must enter silent state without closing the peer connection');
    assert.ok(hook.includes("setStatus('paused')"), 'voice hook Stop action must pause instead of closing the physical call');
    assert.ok(stopBlock.includes('setMicEnabled(false)'), 'Stop must mute the mic track');
    assert.equal(stopBlock.includes('closeJawCeoVoice'), false, 'Stop must not call the server close route');
    assert.equal(stopBlock.includes('.close()'), false, 'Stop must not close the physical peer session');
    assert.ok(talkBlock.includes('if (sessionRef.current)'), 'Talk must check for an existing physical call first');
    assert.ok(talkBlock.indexOf('sessionRef.current.setMicEnabled(true)') < talkBlock.indexOf('createJawCeoVoicePeerSession'), 'Talk must resume before creating a new peer session');
    assert.ok(hiddenCloseBlock.includes('current.close()'), 'hidden dashboard must close the physical peer session');
    assert.ok(hiddenCloseBlock.includes('closeJawCeoVoice(current.sessionId)'), 'hidden dashboard must close the server voice session');
    assert.ok(hook.includes("playJawCeoVoiceCue('silent')"), 'voice hook must provide a throttled still-listening cue');
    assert.ok(silentBlock.includes('SILENT_CUE_MIN_INTERVAL_MS'), 'silent cue must have a minimum repeat interval');
    assert.ok(silentBlock.includes('now - lastSilentCueAtRef.current >= SILENT_CUE_MIN_INTERVAL_MS'), 'silent cue must be throttled by last cue time');
    assert.ok(silentBlock.includes('lastSilentCueAtRef.current = now'), 'silent cue throttle timestamp must update after playback');
    assert.ok(cues.includes("export type JawCeoVoiceCue = 'start' | 'silent' | 'stop' | 'error'"), 'voice cues must remain bounded to state transitions');
    assert.ok(bridge.includes('<JawCeoVoiceOverlay'), 'dashboard bridge must mount the voice overlay');
    assert.ok(app.includes('jawCeoVoiceOverlay={jawCeoBridge.voiceOverlay}'), 'App must pass the overlay through the shell router');
    assert.ok(router.includes('jawCeoVoiceOverlay?: ReactNode'), 'router must expose a shell-level overlay slot');
    assert.notEqual(overlayIndex, -1, 'router must render the voice overlay');
    assert.ok(overlayIndex < layoutIndex, 'overlay must render as a shell-level sibling before WorkspaceLayout');
    assert.ok(overlayIndex < workspaceLayerIndex, 'overlay must not be mounted inside workspace-surface-layer');
    assert.ok(overlay.includes('aria-label="Stop Jaw CEO voice"'), 'overlay stop control must be accessible');
    assert.ok(main.includes('./jaw-ceo/jaw-ceo-console.css'), 'manager entry must load modern CEO console CSS');
    assert.ok(consolePanel.includes('jaw-ceo-console-titlebar'), 'console header must use the modern titlebar layout');
    assert.ok(consolePanel.includes('jaw-ceo-console-summary'), 'console header must expose compact status summary chips');
    assert.ok(consolePanels.includes('jaw-ceo-empty-state'), 'chat panel must render a designed empty state');
    assert.ok(consolePanels.includes('jaw-ceo-quick-prompts'), 'chat panel must expose quick prompt actions');
    assert.ok(consolePanels.includes('jaw-ceo-message-row'), 'chat panel must render chatbot-style message rows');
    assert.ok(consolePanels.includes('jaw-ceo-activity-group'), 'chat panel must render tool/result activity groups');
    assert.ok(consolePanels.includes('args.ceo.pending'), 'pending worker results must be folded into the chat timeline');
    assert.ok(consolePanels.includes('watches.map'), 'watched worker state must be folded into the chat timeline');
    assert.ok(consolePanels.includes('audit.slice'), 'tool/audit records must be folded into the chat timeline');
    assert.ok(consolePanels.includes('args.voice.lastTranscript'), 'realtime voice transcript must render inside the chat timeline');
    assert.ok(consolePanel.includes('lastTranscript'), 'console footer must surface realtime transcript hints');
    assert.ok(consolePanel.includes("voice-${props.voice.status}"), 'console footer must expose voice status styling hooks');
    assert.ok(css.includes('.jaw-ceo-voice-overlay'), 'CSS must style the center voice overlay');
    assert.ok(css.includes('.jaw-ceo-voice-stop'), 'CSS must style the center Stop button');
    assert.ok(consoleCss.includes('.jaw-ceo-console-summary'), 'modern console CSS must style summary chips');
    assert.ok(consoleCss.includes('.jaw-ceo-empty-state'), 'modern console CSS must style the empty state');
    assert.ok(consoleCss.includes('.jaw-ceo-message-row'), 'modern console CSS must style chatbot message rows');
    assert.ok(consoleCss.includes('.jaw-ceo-activity-group'), 'modern console CSS must style activity groups');
    assert.ok(css.includes('prefers-reduced-motion'), 'CSS must reduce waveform motion when requested');
});

test('jaw-ceo activity result rows use the shared context menu with hover icon actions', () => {
    const panels = read('public/manager/src/jaw-ceo/JawCeoConsolePanels.tsx');
    const consoleCss = read('public/manager/src/jaw-ceo/jaw-ceo-console.css');

    assert.ok(panels.includes('useContextMenu'), 'result rows must open the shared context menu');
    assert.ok(panels.includes('jaw-ceo-activity-actions jaw-row-hover-actions'), 'row actions must be hover/focus-revealed icon buttons');
    for (const label of ['Open worker', 'Summarize result', 'Continue', 'Speak result', 'Acknowledge']) {
        assert.ok(panels.includes(label), `result context menu must include ${label}`);
    }
    assert.ok(panels.includes("event.key === 'ContextMenu'"), 'result rows must open the menu from the keyboard ContextMenu key');
    assert.equal(consoleCss.includes('.jaw-ceo-activity-actions button'), false, 'result rows must not keep always-visible text action buttons');
});
