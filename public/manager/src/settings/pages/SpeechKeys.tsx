// Phase 4 — Speech-to-Text engines & API keys page.
//
// One settings page with conditional sub-sections per STT engine. The
// engine selector gates visibility of the sub-sections; engine === 'auto'
// reveals all four so the user can configure fallbacks ahead of time.
//
// Settings keys (all under `stt.*`):
//   stt.engine            'auto' | 'gemini' | 'openai' | 'whisper' | 'vertex'
//   stt.geminiApiKey      SecretField, never seeded (server returns last4 only)
//   stt.geminiModel       TextField with model suggestions
//   stt.openaiApiKey      SecretField, never seeded
//   stt.openaiBaseUrl     TextField (optional, defaults to api.openai.com)
//   stt.openaiModel       TextField (free-form, e.g. 'whisper-1')
//   stt.whisperModel      TextField (HuggingFace / mlx-community model id)
//   stt.vertexConfig      JsonEditorField — service-account credentials
//
// Secret hygiene:
//   The /api/settings GET strips geminiApiKey/openaiApiKey from the
//   response payload and instead returns geminiKeySet/geminiKeyLast4
//   (and the same for openai). We use those flags to render the
//   "••••last4" placeholder. We never seed the actual secret value.
//   For vertexConfig the server currently returns the raw string —
//   that's a backend hygiene gap outside this phase's scope. We keep
//   the JSON editor masked-by-default to limit shoulder-surfing risk.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { TextField, SecretField, SelectField, JsonEditorField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    SettingsNote,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';

export const STT_ENGINES = ['auto', 'gemini', 'openai', 'whisper', 'vertex'] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

const ENGINE_LABELS: Record<SttEngine, string> = {
    auto: 'Auto (try in order)',
    gemini: 'Gemini',
    openai: 'OpenAI',
    whisper: 'Whisper (local MLX)',
    vertex: 'Vertex AI',
};

/**
 * Pure helper — which sub-sections should be visible for a given engine.
 * 'auto' reveals all so a fallback ladder can be configured up front.
 */
export function revealsForEngine(engine: SttEngine): ReadonlyArray<Exclude<SttEngine, 'auto'>> {
    if (engine === 'auto') return ['gemini', 'openai', 'whisper', 'vertex'] as const;
    return [engine];
}

/** Pure JSON validator — empty strings are valid (clears the config). */
export function validateVertexConfig(raw: string): { valid: boolean; error: string | null } {
    if (raw.trim() === '') return { valid: true, error: null };
    try {
        JSON.parse(raw);
        return { valid: true, error: null };
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid JSON';
        return { valid: false, error: message };
    }
}

type SttBlock = {
    engine?: string;
    geminiApiKey?: string;
    geminiKeySet?: boolean;
    geminiKeyLast4?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiKeySet?: boolean;
    openaiKeyLast4?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
    whisperModel?: string;
    vertexConfig?: string;
};

type SpeechSnapshot = {
    stt?: SttBlock;
    [key: string]: unknown;
};

const SPEECH_KEYS = [
    'stt.engine',
    'stt.geminiApiKey',
    'stt.geminiModel',
    'stt.openaiApiKey',
    'stt.openaiBaseUrl',
    'stt.openaiModel',
    'stt.whisperModel',
    'stt.vertexConfig',
] as const;

function normalizeEngine(value: unknown): SttEngine {
    return STT_ENGINES.includes(value as SttEngine) ? (value as SttEngine) : 'auto';
}

export default function SpeechKeys({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<SpeechSnapshot>(client, '/api/settings');

    const [engine, setEngine] = useState<SttEngine>('auto');
    const [geminiApiKey, setGeminiApiKey] = useState('');
    const [geminiModel, setGeminiModel] = useState('');
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
    const [openaiModel, setOpenaiModel] = useState('');
    const [whisperModel, setWhisperModel] = useState('');
    const [vertexConfig, setVertexConfig] = useState('');
    const [vertexError, setVertexError] = useState<string | null>(null);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const stt = state.data.stt || {};
        setEngine(normalizeEngine(stt.engine));
        // Secrets: GET strips the values; never seed them. Only model + URL
        // are safe to seed since they aren't credentials.
        setGeminiApiKey('');
        setGeminiModel(stt.geminiModel ?? '');
        setOpenaiApiKey('');
        setOpenaiBaseUrl(stt.openaiBaseUrl ?? '');
        setOpenaiModel(stt.openaiModel ?? '');
        setWhisperModel(stt.whisperModel ?? '');
        setVertexConfig(stt.vertexConfig ?? '');
        setVertexError(null);
    }, [state]);

    useEffect(() => {
        return () => {
            for (const key of SPEECH_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<SttBlock>(() => {
        if (state.kind !== 'ready') return {};
        return state.data.stt || {};
    }, [state]);

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const patch = expandPatch(bundle);
        const updated = await client.put<SpeechSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: SpeechSnapshot }).data
            : updated) as SpeechSnapshot;
        dirty.clear();
        setData(fresh);
        const stt = fresh.stt || {};
        setEngine(normalizeEngine(stt.engine));
        setGeminiApiKey('');
        setGeminiModel(stt.geminiModel ?? '');
        setOpenaiApiKey('');
        setOpenaiBaseUrl(stt.openaiBaseUrl ?? '');
        setOpenaiModel(stt.openaiModel ?? '');
        setWhisperModel(stt.whisperModel ?? '');
        setVertexConfig(stt.vertexConfig ?? '');
        setVertexError(null);
        await refresh();
    }, [client, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const reveal = revealsForEngine(engine);
    const showGemini = reveal.includes('gemini');
    const showOpenai = reveal.includes('openai');
    const showWhisper = reveal.includes('whisper');
    const showVertex = reveal.includes('vertex');

    const geminiPlaceholder = original.geminiKeySet
        ? `••••••••${original.geminiKeyLast4 ?? ''}`
        : '(empty)';
    const openaiPlaceholder = original.openaiKeySet
        ? `••••••••${original.openaiKeyLast4 ?? ''}`
        : '(empty)';

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Engine"
                hint="Pick a single engine, or 'auto' to fall back through the ladder."
            >
                <SelectField
                    id="stt-engine"
                    label="Speech-to-text engine"
                    value={engine}
                    options={STT_ENGINES.map((value) => ({
                        value,
                        label: ENGINE_LABELS[value],
                    }))}
                    onChange={(next) => {
                        const normalized = normalizeEngine(next);
                        setEngine(normalized);
                        setEntry('stt.engine', {
                            value: normalized,
                            original: normalizeEngine(original.engine),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>

            {showGemini ? (
                <SettingsSection
                    title="Gemini"
                    hint="Google AI Studio key. Used by the Gemini transcription path."
                >
                    <SecretField
                        id="stt-gemini-key"
                        label="API key"
                        value={geminiApiKey}
                        placeholder={geminiPlaceholder}
                        onChange={(next) => {
                            setGeminiApiKey(next);
                            if (next.length === 0) {
                                dirty.remove('stt.geminiApiKey');
                                return;
                            }
                            setEntry('stt.geminiApiKey', {
                                value: next,
                                // Server doesn't echo the secret back, so
                                // we use empty-string as the original. Any
                                // typed value is a real change.
                                original: '',
                                valid: true,
                            });
                        }}
                    />
                    <TextField
                        id="stt-gemini-model"
                        label="Model"
                        value={geminiModel}
                        placeholder="gemini-2.5-flash-lite"
                        onChange={(next) => {
                            setGeminiModel(next);
                            setEntry('stt.geminiModel', {
                                value: next,
                                original: original.geminiModel ?? '',
                                valid: true,
                            });
                        }}
                    />
                </SettingsSection>
            ) : null}

            {showOpenai ? (
                <SettingsSection
                    title="OpenAI"
                    hint="Compatible with OpenAI-style transcription endpoints (incl. self-hosted)."
                >
                    <SecretField
                        id="stt-openai-key"
                        label="API key"
                        value={openaiApiKey}
                        placeholder={openaiPlaceholder}
                        onChange={(next) => {
                            setOpenaiApiKey(next);
                            if (next.length === 0) {
                                dirty.remove('stt.openaiApiKey');
                                return;
                            }
                            setEntry('stt.openaiApiKey', {
                                value: next,
                                original: '',
                                valid: true,
                            });
                        }}
                    />
                    <TextField
                        id="stt-openai-base-url"
                        label="Base URL (optional)"
                        value={openaiBaseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(next) => {
                            setOpenaiBaseUrl(next);
                            setEntry('stt.openaiBaseUrl', {
                                value: next,
                                original: original.openaiBaseUrl ?? '',
                                valid: true,
                            });
                        }}
                    />
                    <TextField
                        id="stt-openai-model"
                        label="Model"
                        value={openaiModel}
                        placeholder="whisper-1"
                        onChange={(next) => {
                            setOpenaiModel(next);
                            setEntry('stt.openaiModel', {
                                value: next,
                                original: original.openaiModel ?? '',
                                valid: true,
                            });
                        }}
                    />
                </SettingsSection>
            ) : null}

            {showWhisper ? (
                <SettingsSection
                    title="Whisper (local MLX)"
                    hint="Runs on-device via mlx-whisper. No API key required."
                >
                    <TextField
                        id="stt-whisper-model"
                        label="Model identifier"
                        value={whisperModel}
                        placeholder="mlx-community/whisper-large-v3-mlx"
                        onChange={(next) => {
                            setWhisperModel(next);
                            setEntry('stt.whisperModel', {
                                value: next,
                                original: original.whisperModel ?? '',
                                valid: true,
                            });
                        }}
                    />
                </SettingsSection>
            ) : null}

            {showVertex ? (
                <SettingsSection
                    title="Vertex AI"
                    hint="Service-account credentials JSON for Google Cloud Vertex transcription."
                >
                    <SettingsNote>
                        Paste the service-account credentials JSON. Treated as a
                        secret — invalid JSON refuses to save.
                    </SettingsNote>
                    <JsonEditorField
                        id="stt-vertex-config"
                        label="Credentials JSON"
                        value={vertexConfig}
                        onChange={(next, valid) => {
                            // JsonEditorField stores either parsed JSON
                            // (valid) or the draft string (invalid). We
                            // need a string for the dirty entry so the
                            // server receives the raw JSON it expects.
                            const asString =
                                typeof next === 'string'
                                    ? next
                                    : next === null || next === undefined
                                      ? ''
                                      : JSON.stringify(next);
                            setVertexConfig(asString);
                            const validity = validateVertexConfig(asString);
                            setVertexError(valid ? null : validity.error);
                            setEntry('stt.vertexConfig', {
                                value: asString,
                                original: original.vertexConfig ?? '',
                                valid: valid && validity.valid,
                            });
                        }}
                    />
                    {vertexError ? (
                        <SettingsNote tone="error" role="alert">
                            {vertexError}
                        </SettingsNote>
                    ) : null}
                </SettingsSection>
            ) : null}

            <SettingsSection
                title="Probe"
                hint="A live mic-test isn't available yet — verify by triggering speech-to-text from the active channel."
            >
                <SettingsNote>
                    No backend self-test endpoint is exposed for speech today;
                    this lands as a Phase 9 polish.
                </SettingsNote>
            </SettingsSection>
        </form>
    );
}
