// Phase 2 — avatar upload card.
//
// Avatar upload bypasses the JSON settings client because the route expects a
// raw image body (`Content-Type: image/*` or `application/octet-stream`) plus
// `X-Filename`. We mount our own fetch + state instead of registering with the
// page-level dirty store: uploads are atomic side-effects, not pending edits.

import { useEffect, useRef, useState } from 'react';
import { icon } from '../../../../../js/icons';
import { SettingsNote } from '../page-shell';

type AvatarKind = 'agent' | 'user';

type AvatarMeta =
    | { target: AvatarKind; kind: 'emoji'; updatedAt: number | null }
    | { target: AvatarKind; kind: 'image'; imageUrl: string; updatedAt: number | null };

type EnvelopeMeta =
    | { ok?: boolean; data?: { agent?: AvatarMeta; user?: AvatarMeta } }
    | { agent?: AvatarMeta; user?: AvatarMeta };

type Props = {
    kind: AvatarKind;
    port: number;
};

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

export function AvatarCard({ kind, port }: Props) {
    const [meta, setMeta] = useState<AvatarMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        setError(null);
        setMeta(null);
        fetch(`/i/${port}/api/avatar`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`avatar HTTP ${r.status}`))))
            .then((envelope: EnvelopeMeta) => {
                if (cancelled) return;
                const inner = 'data' in envelope && envelope.data ? envelope.data : envelope;
                const got = (inner as { agent?: AvatarMeta; user?: AvatarMeta })[kind] || null;
                setMeta(got);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [kind, port]);

    const onPick = () => inputRef.current?.click();

    const onFile = async (file: File) => {
        setBusy(true);
        setError(null);
        try {
            const buf = await file.arrayBuffer();
            const ct = file.type || 'application/octet-stream';
            const response = await fetch(`/i/${port}/api/avatar/${kind}/upload`, {
                method: 'POST',
                headers: {
                    'content-type': ct,
                    'x-filename': encodeURIComponent(file.name),
                },
                body: buf,
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`upload failed: ${response.status} ${text}`);
            }
            const envelope = (await response.json()) as
                | { ok?: boolean; data?: AvatarMeta }
                | AvatarMeta;
            const next: AvatarMeta = 'data' in envelope && envelope.data
                ? (envelope.data as AvatarMeta)
                : (envelope as AvatarMeta);
            setMeta(next);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    };

    const onClear = async () => {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/i/${port}/api/avatar/${kind}/image`, {
                method: 'DELETE',
            });
            if (!response.ok) {
                throw new Error(`clear failed: ${response.status}`);
            }
            const envelope = (await response.json()) as
                | { ok?: boolean; data?: AvatarMeta }
                | AvatarMeta;
            const next: AvatarMeta = 'data' in envelope && envelope.data
                ? (envelope.data as AvatarMeta)
                : (envelope as AvatarMeta);
            setMeta(next);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const imageUrl = meta && meta.kind === 'image'
        ? `/i/${port}${meta.imageUrl}`
        : null;
    const label = kind === 'agent' ? 'Agent avatar' : 'User avatar';

    return (
        <div className="settings-avatar-card">
            <div className="settings-avatar-preview" aria-label={`${label} preview`}>
                {imageUrl ? (
                    <img src={imageUrl} alt={`${label} current`} />
                ) : kind === 'agent' ? (
                    <img className="settings-avatar-mascot" src="/icons/mascot.png" alt="" aria-hidden="true" />
                ) : (
                    <span
                        className="settings-avatar-placeholder"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: icon('user', 28) }}
                    />
                )}
            </div>
            <div className="settings-avatar-controls">
                <span className="settings-field-label">{label}</span>
                <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPTED_TYPES}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onFile(file);
                    }}
                />
                <div className="settings-avatar-buttons">
                    <button
                        type="button"
                        className="settings-action"
                        onClick={onPick}
                        disabled={busy}
                    >
                        {busy ? 'Working…' : 'Upload image'}
                    </button>
                    {imageUrl ? (
                        <button
                            type="button"
                            className="settings-action settings-action-danger"
                            onClick={() => void onClear()}
                            disabled={busy}
                        >
                            Clear
                        </button>
                    ) : null}
                </div>
                {error ? (
                    <SettingsNote tone="error" role="alert">{error}</SettingsNote>
                ) : null}
            </div>
        </div>
    );
}
