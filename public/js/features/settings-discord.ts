// ── Discord Settings ──
import { apiJson } from '../api.js';
import { openSetupGuideIfUnconfigured } from './channel-setup-guide.js';
import { t } from './i18n.js';
import type { SettingsData } from './settings-types.js';

let discordEnvironmentVariables: string[] = [];

function discordEnvironmentMessage(): string {
    return t('settings.discord.managedByEnvironment', {
        variables: discordEnvironmentVariables.join(', ') || 'DISCORD_*',
    });
}

export async function saveDiscordSettings(): Promise<void> {
    if (discordEnvironmentVariables.length > 0) {
        window.alert(discordEnvironmentMessage());
        return;
    }
    const token = (document.getElementById('dcToken') as HTMLInputElement)?.value.trim() || '';
    const guildId = (document.getElementById('dcGuildId') as HTMLInputElement)?.value.trim() || '';
    const channelIdsRaw = (document.getElementById('dcChannelIds') as HTMLInputElement)?.value.trim() || '';
    const channelIds = channelIdsRaw
        ? channelIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    await apiJson('/api/settings', 'PUT', { discord: { token, guildId, channelIds } });
}

export async function setDiscord(enabled: boolean): Promise<void> {
    if (discordEnvironmentVariables.length > 0) {
        window.alert(discordEnvironmentMessage());
        return;
    }
    document.getElementById('dcOn')?.classList.toggle('active', enabled);
    document.getElementById('dcOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { discord: { enabled } });
    if (enabled) openSetupGuideIfUnconfigured('discord');
}

export async function setDiscordForwardAll(enabled: boolean): Promise<void> {
    document.getElementById('dcForwardOn')?.classList.toggle('active', enabled);
    document.getElementById('dcForwardOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { discord: { forwardAll: enabled } });
}

export async function setDiscordAllowBots(allow: boolean): Promise<void> {
    document.getElementById('dcAllowBotsOn')?.classList.toggle('active', allow);
    document.getElementById('dcAllowBotsOff')?.classList.toggle('active', !allow);
    await apiJson('/api/settings', 'PUT', { discord: { allowBots: allow } });
}

export async function setDiscordMentionOnly(enabled: boolean): Promise<void> {
    document.getElementById('dcMentionOn')?.classList.toggle('active', enabled);
    document.getElementById('dcMentionOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { discord: { mentionOnly: enabled } });
}

export function loadDiscordSettings(s: SettingsData): void {
    if (!s.discord) return;
    const dc = s.discord;
    discordEnvironmentVariables = Array.isArray(s.discordEnvironmentVariables)
        ? s.discordEnvironmentVariables
        : [];
    const environmentManaged = discordEnvironmentVariables.length > 0;
    const notice = document.getElementById('discord-environment-managed');
    if (notice) {
        notice.style.display = environmentManaged ? '' : 'none';
        notice.textContent = environmentManaged
            ? t('settings.discord.managedByEnvironment', { variables: discordEnvironmentVariables.join(', ') })
            : '';
    }
    for (const id of ['dcToken', 'dcGuildId', 'dcChannelIds']) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.disabled = environmentManaged;
    }
    for (const id of ['dcOff', 'dcOn', 'discord-onboarding-trigger']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = environmentManaged;
    }
    document.getElementById('dcOn')?.classList.toggle('active', !!dc.enabled);
    document.getElementById('dcOff')?.classList.toggle('active', !dc.enabled);
    const dcToken = document.getElementById('dcToken') as HTMLInputElement | null;
    if (dcToken) dcToken.value = environmentManaged ? '' : dc.token || '';
    const dcGuildId = document.getElementById('dcGuildId') as HTMLInputElement | null;
    if (dcGuildId) dcGuildId.value = environmentManaged ? '' : dc.guildId || '';
    const dcChannelIds = document.getElementById('dcChannelIds') as HTMLInputElement | null;
    if (dcChannelIds) dcChannelIds.value = environmentManaged ? '' : dc.channelIds?.join(', ') || '';
    const fwdOn = dc.forwardAll !== false;
    document.getElementById('dcForwardOn')?.classList.toggle('active', fwdOn);
    document.getElementById('dcForwardOff')?.classList.toggle('active', !fwdOn);
    const allowBots = !!dc.allowBots;
    document.getElementById('dcAllowBotsOn')?.classList.toggle('active', allowBots);
    document.getElementById('dcAllowBotsOff')?.classList.toggle('active', !allowBots);
    const mentionOnly = !!dc.mentionOnly;
    document.getElementById('dcMentionOn')?.classList.toggle('active', mentionOnly);
    document.getElementById('dcMentionOff')?.classList.toggle('active', !mentionOnly);
}
