// ── Telegram Settings ──
import { apiJson } from '../api.js';
import { openSetupGuideIfUnconfigured } from './channel-setup-guide.js';
import { t } from './i18n.js';
import type { SettingsData } from './settings-types.js';

let telegramEnvironmentVariables: string[] = [];

function telegramEnvironmentMessage(): string {
    return t('settings.telegram.managedByEnvironment', {
        variables: telegramEnvironmentVariables.join(', ') || 'TELEGRAM_*',
    });
}

export async function saveTelegramSettings(): Promise<void> {
    if (telegramEnvironmentVariables.length > 0) {
        window.alert(telegramEnvironmentMessage());
        return;
    }
    const token = (document.getElementById('tgToken') as HTMLInputElement)?.value.trim() || '';
    const chatIdsRaw = (document.getElementById('tgChatIds') as HTMLInputElement)?.value.trim() || '';
    const allowedChatIds = chatIdsRaw
        ? chatIdsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
        : [];
    await apiJson('/api/settings', 'PUT', { telegram: { token, allowedChatIds } });
}

export async function setTelegram(enabled: boolean): Promise<void> {
    if (telegramEnvironmentVariables.length > 0) {
        window.alert(telegramEnvironmentMessage());
        return;
    }
    document.getElementById('tgOn')?.classList.toggle('active', enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { enabled } });
    if (enabled) openSetupGuideIfUnconfigured('telegram');
}

export async function setForwardAll(enabled: boolean): Promise<void> {
    document.getElementById('tgForwardOn')?.classList.toggle('active', enabled);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { forwardAll: enabled } });
}

export async function setTelegramMentionOnly(enabled: boolean): Promise<void> {
    document.getElementById('tgMentionOn')?.classList.toggle('active', enabled);
    document.getElementById('tgMentionOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { mentionOnly: enabled } });
}

export function loadTelegramSettings(s: SettingsData): void {
    if (!s.telegram) return;
    const tg = s.telegram;
    telegramEnvironmentVariables = Array.isArray(s.telegramEnvironmentVariables)
        ? s.telegramEnvironmentVariables
        : [];
    const environmentManaged = telegramEnvironmentVariables.length > 0;
    const notice = document.getElementById('telegram-environment-managed');
    if (notice) {
        notice.style.display = environmentManaged ? '' : 'none';
        notice.textContent = environmentManaged
            ? t('settings.telegram.managedByEnvironment', { variables: telegramEnvironmentVariables.join(', ') })
            : '';
    }
    for (const id of ['tgToken', 'tgChatIds']) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.disabled = environmentManaged;
    }
    for (const id of ['tgOff', 'tgOn', 'telegram-onboarding-trigger']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = environmentManaged;
    }
    document.getElementById('tgOn')?.classList.toggle('active', !!tg.enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !tg.enabled);
    const tgToken = document.getElementById('tgToken') as HTMLInputElement | null;
    if (tgToken) tgToken.value = environmentManaged ? '' : tg.token || '';
    const tgChatIds = document.getElementById('tgChatIds') as HTMLInputElement | null;
    if (tgChatIds) tgChatIds.value = environmentManaged ? '' : tg.allowedChatIds?.join(', ') || '';
    const fwdOn = tg.forwardAll !== false;
    document.getElementById('tgForwardOn')?.classList.toggle('active', fwdOn);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !fwdOn);
    const mentionOnly = tg.mentionOnly !== false;
    document.getElementById('tgMentionOn')?.classList.toggle('active', mentionOnly);
    document.getElementById('tgMentionOff')?.classList.toggle('active', !mentionOnly);
}
