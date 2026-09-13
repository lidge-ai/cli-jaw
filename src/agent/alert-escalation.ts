import { broadcast, addBroadcastListener } from '../core/bus.js';
import { settings } from '../core/config.js';
import { sendChannelOutput } from '../messaging/send.js';
import type { MessengerChannel } from '../messaging/types.js';
import { getHomeChannel } from '../messaging/runtime.js';

interface ErrorRecord {
    ts: number;
    type: string;
}

const errorHistory = new Map<string, ErrorRecord[]>();
let lastAlertAt = 0;

function actionForErrorType(type: string): string {
    if (type === 'auth') return 'CLI 로그인 상태 확인 필요';
    if (type === 'model_capacity') return 'Gemini Pro Preview capacity 부족 — Auto/Flash 전환 또는 잠시 후 재시도';
    if (type === '429') return '쿼터/모델 capacity 상태 확인 필요';
    if (type === 'stall') return 'CLI 응답 정지 — 프로세스/네트워크 상태 확인 필요';
    return 'CLI 상태 및 최근 로그 확인 필요';
}

function getConfig() {
    const cfg = (settings as Record<string, unknown>)["alertEscalation"] as Record<string, unknown> | undefined || {};
    return {
        enabled: cfg["enabled"] !== false,
        threshold: (cfg["threshold"] as number) ?? 3,
        windowMs: (cfg["windowMs"] as number) ?? 600_000,
        cooldownMs: (cfg["cooldownMs"] as number) ?? 1_800_000,
        // An operator alert belongs wherever this install actually talks. The
        // old hardcoded 'telegram' meant a Slack-only deployment escalated into
        // a channel nobody had configured, so the alert was simply lost (#519).
        channels: (cfg["channels"] as string[]) ?? [getHomeChannel()],
    };
}

export function recordError(cli: string, type: string): void {
    const cfg = getConfig();
    if (!cfg.enabled) return;

    const now = Date.now();
    const history = errorHistory.get(cli) || [];
    history.push({ ts: now, type });

    const cutoff = now - cfg.windowMs;
    const recent = history.filter(e => e.ts > cutoff);
    errorHistory.set(cli, recent);

    if (recent.length >= cfg.threshold && (now - lastAlertAt) > cfg.cooldownMs) {
        lastAlertAt = now;
        const lastType = recent[recent.length - 1]?.type || 'unknown';
        const msg = `🚨 jaw Alert: ${cli} 연속 실패\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `상태: ${lastType} ${recent.length}회 (${Math.round(cfg.windowMs / 60_000)}분)\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `조치: ${actionForErrorType(lastType)}`;
        broadcast('alert_escalation', { cli, message: msg, channels: cfg.channels });
    }
}

export function clearErrors(cli: string): void {
    errorHistory.delete(cli);
}

let _alertDeliveryInit = false;

export function initAlertDelivery(): void {
    if (_alertDeliveryInit) return;
    _alertDeliveryInit = true;

    addBroadcastListener((type, data) => {
        if (type !== 'alert_escalation') return;
        // The payload normally carries the configured list; this fallback is the
        // second hardcoded 'telegram' and had the same effect as the first.
        const channels = (data["channels"] as string[]) ?? [getHomeChannel()];
        const text = data["message"] as string;
        if (!text) return;

        for (const ch of channels) {
            if (ch !== 'telegram' && ch !== 'discord' && ch !== 'slack') continue;
            // An operational alert belongs in the channel configured to receive
            // one, not in whichever conversation spoke most recently (#438).
            void sendChannelOutput({
                type: 'text', text, channel: ch as MessengerChannel,
                preferConfiguredTarget: true,
                allowActiveFallback: false,
            })
                .then((result) => {
                    if (!result.ok) {
                        console.warn(`[jaw:alert] delivery to ${ch} failed:`, result.error);
                    }
                })
                .catch((err) => {
                    console.warn(`[jaw:alert] delivery to ${ch} threw:`, (err as Error).message);
                });
        }
    });
}
