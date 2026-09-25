// Phase 7 — Inline warning panel used by Network/Permissions pages to surface
// safety implications next to the field that triggers them.
//
// Renders on the shared `settings-card-note` row so the panel participates in
// the card's divided-row rhythm instead of floating unstyled between fields.
// The shared sheet ships only muted/error note tones, and page modules cannot
// import their own css (unit tests load the .tsx directly through tsx, which
// has no css loader), so the warn tone applies --warning-text inline — the
// same token `settings-status-warn` uses.

import type { ReactNode } from 'react';

type Props = {
    children: ReactNode;
    tone?: 'warn' | 'info';
    role?: 'alert' | 'note';
};

const TONE_COLOR: Record<NonNullable<Props['tone']>, string | undefined> = {
    warn: 'var(--warning-text, #b7791f)',
    info: undefined,
};

export function InlineWarn({ children, tone = 'warn', role = 'note' }: Props) {
    const color = TONE_COLOR[tone];
    return (
        <p
            className="settings-card-note"
            role={role}
            style={color ? { color } : undefined}
        >
            {children}
        </p>
    );
}
