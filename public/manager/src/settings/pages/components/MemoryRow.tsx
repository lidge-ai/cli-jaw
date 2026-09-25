// Phase 6 — single row in the Memory browse list.
//
// Pure presentational, rendered on the shared `settings-card-actions` row so
// memory entries read like the other entity rows (MCP servers, heartbeat
// jobs): key + source badge + length + preview on the left, Open on the
// right. Clicking opens a read-only modal with the full value — the modal is
// owned by the parent Memory page so only one is mounted at a time and
// Esc/backdrop dismissal lives in one place.

import type { MemoryEntry } from './memory-helpers';
import { previewValue } from './memory-helpers';
import { StatusBadge } from '../page-shell';

type Props = {
    row: MemoryEntry;
    onOpen: (row: MemoryEntry) => void;
};

export function MemoryRow({ row, onOpen }: Props) {
    return (
        <div className="settings-card-actions">
            <div className="settings-card-actions-status">
                <strong><code>{row.key}</code></strong>{' '}
                <StatusBadge tone="neutral">{row.source}</StatusBadge>{' '}
                <span className="settings-field-hint">
                    {row.value.length} chars · {previewValue(row.value)}
                </span>
            </div>
            <div className="settings-card-actions-buttons">
                <button
                    type="button"
                    className="settings-action"
                    onClick={() => onOpen(row)}
                    aria-label={`Open memory entry ${row.key}`}
                >
                    Open
                </button>
            </div>
        </div>
    );
}
