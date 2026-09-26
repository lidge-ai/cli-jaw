import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ContextMenuAction = {
    kind?: 'action';
    id: string;
    label: string;
    icon?: ReactNode;
    /** Display-only hint, e.g. formatShortcut(...). */
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    title?: string;
    onSelect: () => void;
};
export type ContextMenuSeparator = { kind: 'separator'; id: string };
export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

export type ContextMenuState = { x: number; y: number; opener?: Element | null };

const VIEWPORT_MARGIN = 8;

function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
    return entry.kind !== 'separator';
}

function isFocusable(element: HTMLElement): boolean {
    if (element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return element.tabIndex >= 0 || element.hasAttribute('tabindex') || element.isContentEditable;
}

function isTabbable(element: HTMLElement): boolean {
    return element.tabIndex >= 0 && isFocusable(element);
}

function nextTabbable(opener: Element | null, menu: HTMLElement | null, direction: 1 | -1): HTMLElement | null {
    if (!(opener instanceof HTMLElement)) return null;
    const tabbables = Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter(element => !menu?.contains(element) && isTabbable(element));
    const index = tabbables.indexOf(opener);
    if (index < 0 || tabbables.length < 2) return null;
    return tabbables[(index + direction + tabbables.length) % tabbables.length] ?? null;
}

/**
 * Tracks one open menu. `openAt` takes the right-click (or keyboard) event and
 * anchors the menu at the pointer, or at the target's bottom-left for keyboard
 * invocations that report 0,0.
 */
export function useContextMenu() {
    const [state, setState] = useState<ContextMenuState | null>(null);
    const close = useCallback(() => setState(null), []);
    const openAt = useCallback((event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget;
        const active = document.activeElement;
        const opener = active && target.contains(active) ? active
            : isFocusable(target) ? target
                : Array.from(target.querySelectorAll<HTMLElement>('*')).find(isFocusable) ?? active;
        if ('clientX' in event && (event.clientX !== 0 || event.clientY !== 0)) {
            setState({ x: event.clientX, y: event.clientY, opener });
            return;
        }
        const rect = target.getBoundingClientRect();
        setState({ x: rect.left + 8, y: rect.bottom, opener });
    }, []);
    const openAtElement = useCallback((element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        setState({ x: rect.left, y: rect.bottom + 2, opener: element });
    }, []);
    return { state, open: state !== null, openAt, openAtElement, close };
}

export function ContextMenu({ state, entries, label, onClose, className }: {
    state: ContextMenuState | null;
    entries: ContextMenuEntry[];
    label: string;
    onClose: () => void;
    className?: string;
}) {
    const menu = useRef<HTMLDivElement>(null);
    /** Dismissal hands focus back to the captured opener. */
    const restoreOnClose = useRef(true);
    const pendingRestoreFrame = useRef<number | null>(null);
    const cancelPendingRestore = useCallback(() => {
        if (pendingRestoreFrame.current === null) return;
        window.cancelAnimationFrame(pendingRestoreFrame.current);
        pendingRestoreFrame.current = null;
    }, []);
    const [position, setPosition] = useState<ContextMenuState | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const anchorX = state?.x;
    const anchorY = state?.y;
    const opener = state?.opener;

    useEffect(() => cancelPendingRestore, [cancelPendingRestore]);

    useLayoutEffect(() => {
        if (anchorX === undefined || anchorY === undefined) { setPosition(null); return; }
        const node = menu.current;
        const width = node?.offsetWidth ?? 0;
        const height = node?.offsetHeight ?? 0;
        const maxX = window.innerWidth - width - VIEWPORT_MARGIN;
        const maxY = window.innerHeight - height - VIEWPORT_MARGIN;
        setPosition({
            x: Math.max(VIEWPORT_MARGIN, Math.min(anchorX, maxX)),
            y: Math.max(VIEWPORT_MARGIN, Math.min(anchorY > maxY ? anchorY - height : anchorY, maxY)),
        });
    }, [anchorX, anchorY]);

    useEffect(() => {
        if (anchorX === undefined || anchorY === undefined) return;
        cancelPendingRestore();
        const onClose = () => onCloseRef.current();
        restoreOnClose.current = true;
        const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
        first?.focus({ preventScroll: true });
        const onPointerDown = (event: PointerEvent) => {
            if (menu.current && event.target instanceof Node && menu.current.contains(event.target)) return;
            onClose();
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
        const onDismiss = () => onClose();
        const onScroll = (event: Event) => {
            if (menu.current && event.target instanceof Node && menu.current.contains(event.target)) return;
            onClose();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKey);
        window.addEventListener('blur', onDismiss);
        window.addEventListener('resize', onDismiss);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('blur', onDismiss);
            window.removeEventListener('resize', onDismiss);
            window.removeEventListener('scroll', onScroll, true);
            if (restoreOnClose.current && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
        };
    }, [anchorX, anchorY, opener, cancelPendingRestore]);

    if (!state) return null;

    function moveFocus(step: 1 | -1 | 'first' | 'last') {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = step === 'first' ? 0 : step === 'last' ? items.length - 1
            : (index + step + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
    }

    function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
        // Keys dispatched inside the menu never reach the window keydown
        // listener (stopPropagation below), so dismissal is settled here.
        const moves: Record<string, 1 | -1 | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
        const move = moves[event.key];
        if (move !== undefined) { event.preventDefault(); moveFocus(move); }
        else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        else if (event.key === 'Tab') {
            event.preventDefault();
            const next = nextTabbable(opener ?? null, menu.current, event.shiftKey ? -1 : 1);
            restoreOnClose.current = false;
            onClose();
            next?.focus({ preventScroll: true });
        }
        event.stopPropagation();
    }

    const shown = position ?? state;
    return createPortal(<div ref={menu} className={`jaw-context-menu${className ? ` ${className}` : ''}`} role="menu" aria-label={label}
        style={{ left: shown.x, top: shown.y, visibility: position ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
        {entries.map(entry => isAction(entry)
            ? <button key={entry.id} type="button" role="menuitem" disabled={entry.disabled} title={entry.title}
                className={`jaw-context-menu-item${entry.danger ? ' is-danger' : ''}`}
                onClick={() => {
                    const previousMenu = menu.current;
                    const previousOpener = state.opener;
                    restoreOnClose.current = false;
                    onClose();
                    entry.onSelect();
                    cancelPendingRestore();
                    pendingRestoreFrame.current = window.requestAnimationFrame(() => {
                        pendingRestoreFrame.current = null;
                        const active = document.activeElement;
                        if ((!active || active === document.body || !active.isConnected || (previousMenu?.contains(active) ?? false))
                            && previousOpener instanceof HTMLElement && previousOpener.isConnected) {
                            previousOpener.focus({ preventScroll: true });
                        }
                    });
                }}>
                <span className="jaw-context-menu-icon" aria-hidden="true">{entry.icon}</span>
                <span className="jaw-context-menu-label">{entry.label}</span>
                {entry.shortcut && <kbd className="jaw-context-menu-shortcut" aria-hidden="true">{entry.shortcut}</kbd>}
            </button>
            : <div key={entry.id} className="jaw-context-menu-separator" role="separator" />)}
    </div>, document.body);
}
