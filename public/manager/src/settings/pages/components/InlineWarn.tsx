// Phase 7 — Inline warning panel used by Network/Permissions pages to surface
// safety implications next to the field that triggers them.

import type { ReactNode } from 'react';

type Props = {
    children: ReactNode;
    tone?: 'warn' | 'info';
    role?: 'alert' | 'note';
};

export function InlineWarn({ children, tone = 'warn', role = 'note' }: Props) {
    const className = tone === 'warn'
        ? 'settings-card-note settings-card-note-warn'
        : 'settings-card-note settings-card-note-muted';
    return (
        <p className={className} role={role}>
            {children}
        </p>
    );
}
