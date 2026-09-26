import { useRef, type ReactNode } from 'react';
import type { DashboardUiTheme } from '../types';
import { ContextMenu, useContextMenu, type ContextMenuEntry } from './context-menu/ContextMenu';
import { CheckGlyph } from './context-menu/icons';

type ThemeSwitchProps = {
    theme: DashboardUiTheme;
    onChange: (next: DashboardUiTheme) => void;
};

const glyph = {
    viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
} as const;

const OPTIONS: ReadonlyArray<{ value: DashboardUiTheme; label: string; hint: string; icon: ReactNode }> = [
    { value: 'auto', label: 'Auto', hint: 'Follow OS preference', icon: <svg {...glyph}><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5v13a6.5 6.5 0 0 0 0-13Z" fill="currentColor" stroke="none" /></svg> },
    { value: 'light', label: 'Light', hint: 'Always light theme', icon: <svg {...glyph}><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" /></svg> },
    { value: 'dark', label: 'Dark', hint: 'Always dark theme', icon: <svg {...glyph}><path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2Z" /></svg> },
];

export function ThemeSwitch(props: ThemeSwitchProps) {
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useContextMenu();
    const closedAt = useRef(0);
    const suppressClick = useRef(false);
    const closeMenu = () => { closedAt.current = performance.now(); menu.close(); };
    const current = OPTIONS.find(option => option.value === props.theme) ?? OPTIONS[0]!;
    const entries: ContextMenuEntry[] = OPTIONS.map(option => ({
        id: option.value,
        label: option.label,
        title: option.hint,
        icon: option.value === props.theme ? <CheckGlyph /> : undefined,
        checked: option.value === props.theme,
        onSelect: () => props.onChange(option.value),
    }));
    return (
        <>
            <button
                ref={trigger}
                type="button"
                className={`command-icon-button theme-switch${menu.open ? ' is-open' : ''}`}
                aria-label={`Theme: ${current.label}`}
                aria-haspopup="menu"
                aria-expanded={menu.open}
                title={`Theme: ${current.label}`}
                onPointerDown={() => { suppressClick.current = performance.now() - closedAt.current < 50; }}
                onClick={() => {
                    if (menu.open) { menu.close(); return; }
                    if (suppressClick.current) { suppressClick.current = false; return; }
                    if (trigger.current) menu.openAtElement(trigger.current);
                }}
            >
                {current.icon}
            </button>
            <ContextMenu state={menu.state} entries={entries} label="Theme" onClose={closeMenu} className="theme-switch-menu" />
        </>
    );
}
