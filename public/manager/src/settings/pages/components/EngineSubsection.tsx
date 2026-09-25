// Phase 4 — visual wrapper for an STT engine's sub-section.
//
// Used by SpeechKeys to group an engine's fields under a labelled card.
// Pure presentational; no state. Engine selector visibility is decided by
// the parent based on the current engine value.

import type { ReactNode } from 'react';

type Props = {
    title: string;
    hint?: string;
    children: ReactNode;
};

export function EngineSubsection({ title, hint, children }: Props) {
    return (
        <div className="settings-engine-subsection" role="group" aria-label={title}>
            <p className="settings-engine-subsection-head">{title}</p>
            {hint ? (
                <p className="settings-engine-subsection-hint">{hint}</p>
            ) : null}
            <div className="settings-engine-subsection-body">{children}</div>
        </div>
    );
}
