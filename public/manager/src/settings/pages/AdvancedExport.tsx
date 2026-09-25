// Phase 9 — Advanced export / import.
//
// Read-only export by default; import is hidden behind a "Show advanced"
// toggle. Import validates that the parsed JSON is a plain object before
// shipping a PUT.

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPageProps } from '../types';
import { SettingsSection, SettingsActions, PageError, PageLoading, PageOffline, usePageSnapshot } from './page-shell';
import { ToggleField } from '../fields';
import { describeError } from '../components/error-normalize';

type ExportImportProps = SettingsPageProps & {
    /** Test seam — replaces document.createElement download flow. */
    triggerDownload?: (filename: string, body: string) => void;
};

function defaultDownload(filename: string, body: string) {
    const blob = new Blob([body], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function validateImportPayload(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Import payload must be a JSON object.' };
    }
    return { ok: true, value: stripServerOwnedSettingsFields(parsed as Record<string, unknown>) };
}

export function stripServerOwnedSettingsFields(settings: Record<string, unknown>): Record<string, unknown> {
    const {
        settingsSchemaVersion: _schema,
        runtimeDefaultMigration: _migration,
        multiSessionDefaultMigration: _sessionMigration,
        nativeTransportMigration: _nativeTransportMigration,
        maxConcurrentDefaultMigration: _maxConcurrentDefaultMigration,
        slackEnvironmentVariables: _slackEnvironmentVariables,
        telegramEnvironmentVariables: _telegramEnvironmentVariables,
        discordEnvironmentVariables: _discordEnvironmentVariables,
        ...userOwned
    } = settings;
    return userOwned;
}

export default function AdvancedExport({ port, client, triggerDownload }: ExportImportProps) {
    const { state } = usePageSnapshot<Record<string, unknown>>(client, '/api/settings');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [importText, setImportText] = useState('');
    const [importError, setImportError] = useState<string | null>(null);
    const [importBusy, setImportBusy] = useState(false);
    const [importResult, setImportResult] = useState<string | null>(null);
    const download = triggerDownload || defaultDownload;

    useEffect(() => {
        setImportText('');
        setImportError(null);
        setImportResult(null);
    }, [port]);

    const onExport = useCallback(() => {
        if (state.kind !== 'ready') return;
        const filename = `cli-jaw-settings-${port}.json`;
        download(filename, JSON.stringify(stripServerOwnedSettingsFields(state.data), null, 2));
    }, [state, port, download]);

    const onImport = useCallback(async () => {
        const valid = validateImportPayload(importText);
        if (!valid.ok) {
            setImportError(valid.error);
            setImportResult(null);
            return;
        }
        setImportError(null);
        setImportResult(null);
        setImportBusy(true);
        try {
            await client.put('/api/settings', valid.value);
            setImportResult('Imported. Reload the page to refresh other tabs.');
        } catch (err) {
            setImportError(describeError(err));
        } finally {
            setImportBusy(false);
        }
    }, [client, importText]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    return (
        <div className="settings-page-form">
            <SettingsSection
                title="Export"
                hint={`Download the resolved /i/${port}/api/settings document as JSON.`}
            >
                <SettingsActions>
                    <button
                        type="button"
                        className="settings-action"
                        onClick={onExport}
                    >
                        Download settings JSON
                    </button>
                </SettingsActions>
            </SettingsSection>

            <SettingsSection
                title="Import (advanced)"
                hint="Replaces matching keys via PUT. Only enable when you understand the impact."
            >
                <ToggleField
                    id="advanced-toggle"
                    label="Show import controls"
                    value={showAdvanced}
                    onChange={setShowAdvanced}
                />
                {showAdvanced ? (
                    <>
                        <label className="settings-field" htmlFor="advanced-import">
                            <span className="settings-field-label">Settings JSON</span>
                            <textarea
                                id="advanced-import"
                                rows={8}
                                value={importText}
                                placeholder='{"cli":"codex","tui":{"themeSeed":"jaw-dark"}}'
                                onChange={(event) => setImportText(event.target.value)}
                                aria-invalid={Boolean(importError)}
                            />
                            {importError ? (
                                <span className="settings-field-error" role="alert">
                                    {importError}
                                </span>
                            ) : null}
                        </label>
                        <SettingsActions status={importResult ? <span role="status">{importResult}</span> : undefined}>
                            <button
                                type="button"
                                className="settings-action settings-action-save"
                                onClick={() => void onImport()}
                                disabled={importBusy || importText.trim() === ''}
                            >
                                {importBusy ? 'Importing…' : 'Apply import'}
                            </button>
                        </SettingsActions>
                    </>
                ) : null}
            </SettingsSection>
        </div>
    );
}
