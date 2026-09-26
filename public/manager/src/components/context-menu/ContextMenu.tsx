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

export type ContextMenuState = { x: number; y: number };

const VIEWPORT_MARGIN = 8;

function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
    return entry.kind !== 'separator';
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
        if ('clientX' in event && (event.clientX !== 0 || event.clientY !== 0)) {
            setState({ x: event.clientX, y: event.clientY });
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setState({ x: rect.left + 8, y: rect.bottom });
    }, []);
    const openAtElement = useCallback((element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        setState({ x: rect.left, y: rect.bottom + 2 });
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
    const restoreFocus = useRef<Element | null>(null);
    /** Dismissal hands focus back to the opener; choosing an item leaves focus to the action. */
    const restoreOnClose = useRef(true);
    const [position, setPosition] = useState<ContextMenuState | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const anchorX = state?.x;
    const anchorY = state?.y;

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
        const onClose = () => onCloseRef.current();
        restoreFocus.current = document.activeElement;
        restoreOnClose.current = true;
        const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
        first?.focus({ preventScroll: true });
        const onPointerDown = (event: PointerEvent) => {
            if (menu.current && event.target instanceof Node && menu.current.contains(event.target)) return;
            onClose();
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
        const onDismiss = () => onClose();
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKey);
        window.addEventListener('blur', onDismiss);
        window.addEventListener('resize', onDismiss);
        window.addEventListener('scroll', onDismiss, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('blur', onDismiss);
            window.removeEventListener('resize', onDismiss);
            window.removeEventListener('scroll', onDismiss, true);
            const previous = restoreFocus.current;
            if (restoreOnClose.current && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
        };
    }, [anchorX, anchorY]);

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
        const moves: Record<string, 1 | -1 | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
        const move = moves[event.key];
        if (move !== undefined) { event.preventDefault(); moveFocus(move); }
        else if (event.key === 'Tab') { event.preventDefault(); onClose(); }
        event.stopPropagation();
    }

    const shown = position ?? state;
    return createPortal(<div ref={menu} className={`jaw-context-menu${className ? ` ${className}` : ''}`} role="menu" aria-label={label}
        style={{ left: shown.x, top: shown.y, visibility: position ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
        {entries.map(entry => isAction(entry)
            ? <button key={entry.id} type="button" role="menuitem" disabled={entry.disabled} title={entry.title}
                className={`jaw-context-menu-item${entry.danger ? ' is-danger' : ''}`}
                onClick={() => { restoreOnClose.current = false; onClose(); entry.onSelect(); }}>
                <span className="jaw-context-menu-icon" aria-hidden="true">{entry.icon}</span>
                <span className="jaw-context-menu-label">{entry.label}</span>
                {entry.shortcut && <kbd className="jaw-context-menu-shortcut" aria-hidden="true">{entry.shortcut}</kbd>}
            </button>
            : <div key={entry.id} className="jaw-context-menu-separator" role="separator" />)}
    </div>, document.body);
}
