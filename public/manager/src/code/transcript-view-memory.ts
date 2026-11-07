export type TranscriptAnchor = { itemId: string | null; offset: number; firstSequence: number | null; successors: string[]; following: boolean };
export type TranscriptView = { open: Map<string, boolean>; anchor: TranscriptAnchor | null };

const sessions = new Map<string, TranscriptView>();
function copy(view: TranscriptView): TranscriptView {
    return { open: new Map(view.open), anchor: view.anchor ? { ...view.anchor, successors: view.anchor.successors.slice(0, 16) } : null };
}

export function readTranscriptView(key: string): TranscriptView {
    const view = sessions.get(key);
    if (!view) return { open: new Map(), anchor: null };
    sessions.delete(key); sessions.set(key, view);
    return copy(view);
}

export function writeTranscriptView(key: string, update: Partial<TranscriptView>): void {
    const previous = readTranscriptView(key);
    const view = copy({ ...previous, ...update });
    while (view.open.size > 64) view.open.delete(view.open.keys().next().value!);
    sessions.delete(key); sessions.set(key, view);
    if (sessions.size > 32) sessions.delete(sessions.keys().next().value!);
}

export function forgetTranscriptView(key: string): void { sessions.delete(key); }
export function __resetTranscriptViewMemoryForTests(): void { sessions.clear(); }
