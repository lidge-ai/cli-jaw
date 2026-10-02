// Synthetic public fixture matching observed Aside AgentMessage storage shape.
// User timestamp precedes started while storage order is started/user/assistant/finished.
export const prior = [
    { role: 'turn-lifecycle', event: 'started', turnId: 'prior-turn', timestamp: 110 },
    { role: 'user', content: [{ type: 'text', text: 'Previous question' }], timestamp: 100 },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], stopReason: 'stop', completedAt: 120, timestamp: 111 },
    { role: 'turn-lifecycle', event: 'finished', turnId: 'prior-turn', timestamp: 121 },
];
export const started = [
    { role: 'turn-lifecycle', event: 'started', turnId: 'owned-turn', timestamp: 210 },
    { role: 'user', content: [{ type: 'text', text: 'New question' }], timestamp: 200 },
];
export const tool = { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'sleep', arguments: { seconds: 1 } }], stopReason: 'toolUse', timestamp: 211 };
export function completed(text: string = 'new answer') {
    return [...started,
        { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', completedAt: 220, timestamp: 211 },
        { role: 'turn-lifecycle', event: 'finished', turnId: 'owned-turn', timestamp: 221 },
    ];
}
export function snapshot(storage: unknown[], status = 'idle', id = 'owned-session') {
    return { before: { id, status }, session: { id, status }, messages: [...storage].reverse(), limit: 200, order: 'desc' };
}
