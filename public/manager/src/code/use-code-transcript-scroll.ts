import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CodeItem } from '../../../../src/code-mode/wire';
import type { CodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';
import { readTranscriptView, writeTranscriptView, type TranscriptAnchor } from './transcript-view-memory';

const BOTTOM_SLOP = 64;
type Generation = { key: string; saved: TranscriptAnchor | null; following: boolean; pending: boolean; userWon: boolean; passes: number; stable: number; firstId: string };

export function useCodeTranscriptScroll({ items, sessionKey, transcriptRef, virtual, hydrating }: {
    items: CodeItem[]; sessionKey: string; transcriptRef: RefObject<HTMLDivElement | null>; virtual: CodeTranscriptVirtualRows; hydrating: boolean;
}) {
    const [showJump, setShowJump] = useState(false);
    const generation = useRef<Generation | null>(null);
    if (!generation.current || generation.current.key !== sessionKey) {
        const saved = readTranscriptView(sessionKey).anchor;
        generation.current = { key: sessionKey, saved, following: saved?.following ?? true, pending: !!saved && !saved.following,
            userWon: false, passes: 0, stable: 0, firstId: '' };
    }
    const g = generation.current;
    const state = useRef({ items, virtual, hydrating });
    state.current = { items, virtual, hydrating };
    const save = useCallback((owner: Generation, node: HTMLDivElement) => {
        if (generation.current !== owner || owner.pending || state.current.hydrating || !state.current.items.length) return;
        const current = state.current;
        const row = current.virtual.virtualItems.find(value => value.end > node.scrollTop);
        const index = row?.index ?? -1;
        const item = current.items[index];
        const anchor: TranscriptAnchor = { itemId: item?.itemId ?? null, offset: row ? node.scrollTop - row.start : 0,
            firstSequence: item?.firstSequence ?? null, successors: index >= 0 ? current.items.slice(index + 1, index + 17).map(value => value.itemId) : [], following: owner.following };
        owner.saved = anchor;
        writeTranscriptView(owner.key, { anchor });
    }, []);
    const derive = useCallback((owner: Generation, node: HTMLDivElement) => {
        owner.following = node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLOP;
        setShowJump(!owner.following); save(owner, node);
    }, [save]);
    const jumpToLatest = useCallback(() => {
        const node = transcriptRef.current; const owner = generation.current;
        if (!node || !owner) return;
        owner.pending = false; owner.following = true; owner.userWon = false;
        node.scrollTop = node.scrollHeight; setShowJump(false); save(owner, node);
    }, [transcriptRef, save]);

    useLayoutEffect(() => {
        const node = transcriptRef.current;
        if (!node) return;
        // A scroll event after rows exist is the reader's position in real
        // geometry, so it also ends an intent latched during a restore.
        const onScroll = () => { if (!g.pending && !state.current.hydrating) { g.userWon = false; derive(g, node); } };
        // Intent only has to override a restore that is still running (pending,
        // or waiting for rows). Outside that window the scroll event that follows
        // already records the reader's position, and latching here would stop
        // bottom-follow for the rest of the session.
        const intent = () => {
            if (g.pending || state.current.hydrating) g.userWon = true;
            g.pending = false;
        };
        const keydown = (event: KeyboardEvent) => {
            if (event.target === node && !event.altKey && !event.ctrlKey && !event.metaKey && ['j', 'd', 'k', 'u', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) intent();
        };
        const pointer = (event: PointerEvent) => { if (event.target === node) intent(); };
        node.addEventListener('scroll', onScroll, { passive: true });
        node.addEventListener('wheel', intent, { passive: true }); node.addEventListener('touchmove', intent, { passive: true });
        node.addEventListener('keydown', keydown); node.addEventListener('pointerdown', pointer);
        return () => {
            node.removeEventListener('scroll', onScroll); node.removeEventListener('wheel', intent); node.removeEventListener('touchmove', intent);
            node.removeEventListener('keydown', keydown); node.removeEventListener('pointerdown', pointer);
        };
    }, [g, transcriptRef, derive]);

    useLayoutEffect(() => {
        const node = transcriptRef.current;
        if (!node) return;
        let frame = 0;
        const pass = (fromFrame: boolean) => {
            if (generation.current !== g || state.current.hydrating || !state.current.items.length) return;
            const current = state.current;
            if (g.userWon) { derive(g, node); return; }
            const firstId = current.items[0]?.itemId ?? '';
            if (!g.pending && !g.following && g.firstId && g.firstId !== firstId && g.saved) {
                g.pending = true; g.passes = 0; g.stable = 0;
            }
            g.firstId = firstId;
            if (g.following) { node.scrollTop = node.scrollHeight; save(g, node); setShowJump(false); return; }
            if (!g.pending || !g.saved) return;
            const saved = g.saved;
            let index = current.items.findIndex(item => item.itemId === saved.itemId);
            if (index < 0 && saved.firstSequence !== null) index = current.items.findIndex(item => item.firstSequence !== undefined && item.firstSequence > saved.firstSequence!);
            if (index < 0) index = saved.successors.map(id => current.items.findIndex(item => item.itemId === id)).find(value => value >= 0) ?? -1;
            if (index < 0) { g.pending = false; g.following = true; node.scrollTop = node.scrollHeight; save(g, node); setShowJump(false); return; }
            current.virtual.restoreAnchor(index, saved.offset);
            const target = current.virtual.virtualItems.find(row => row.index === index);
            const measured = !!target && current.virtual.isMeasured(index) && current.virtual.virtualItems.filter(row => row.start < target.start + node.clientHeight).every(row => current.virtual.isMeasured(row.index));
            const desired = target ? Math.max(0, Math.min(target.start + saved.offset, node.scrollHeight - node.clientHeight)) : NaN;
            g.stable = measured && Math.abs(node.scrollTop - desired) <= 1 ? g.stable + 1 : 0;
            if (fromFrame) g.passes++;
            if (g.stable >= 2 || g.passes >= 24) { g.pending = false; derive(g, node); }
            else frame = window.requestAnimationFrame(() => pass(true));
        };
        pass(false);
        return () => { if (frame) window.cancelAnimationFrame(frame); };
    }, [g, items, virtual.totalSize, virtual.virtualItems, hydrating, transcriptRef, derive, save]);
    return { showJump, jumpToLatest };
}
