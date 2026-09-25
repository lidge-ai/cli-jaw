// ── Virtual Scroll (TanStack Virtual Core) ──
import {
    Virtualizer,
    elementScroll,
    observeElementRect,
    observeElementOffset,
} from '@tanstack/virtual-core';
import { generateId } from './uuid.js';
import { releaseMermaidNodes } from './render.js';
import { releaseProcessBlockDetails } from './features/process-block.js';

// Activate immediately: tanstack keeps only visible items mounted.
const THRESHOLD = 1;
const EST_HEIGHT = 80;
const OVERSCAN = 5;
const BOTTOM_THRESHOLD = 80;
/** Quiet period after the last width change before a resize drag counts as done. */
const RESIZE_SETTLE_MS = 160;

export type RestoreReason =
    | 'pageshow'
    | 'visibility'
    | 'focus'
    | 'pagehide'
    | 'freeze'
    | 'resume'
    | 'discard'
    | 'reconnect'
    | 'manual';

export interface VirtualItem {
    id: string;
    messageId?: string;
    html: string;
    height: number; // used as estimateSize hint; tanstack measures real heights
    rehydratesProcessDetails?: boolean;
}

export type LazyRenderCallback = (targets: HTMLElement[]) => void;
export type RestoreFollowPredicate = () => boolean;
export interface VirtualLifecycleHooks {
    postRender(root: HTMLElement): void;
    recycle(element: HTMLElement): void;
}
type MeasurableVirtualElement = Pick<HTMLElement, 'getBoundingClientRect'>;
interface ScrollAnchor {
    el: HTMLElement;
    top: number;
}
/** Where the reader was when a resize drag began. Captured once per drag so
 *  per-frame corrections never inherit the previous frame's drift. */
interface ResizePin {
    follow: boolean;
    anchor: { index: number; top: number } | null;
    settleTimer: number;
}

function readMeasuredHeight(el: MeasurableVirtualElement): number {
    const height = Math.ceil(el.getBoundingClientRect().height);
    return Number.isFinite(height) && height > 0 ? height : 0;
}

export function syncMeasuredItemHeight(
    items: VirtualItem[],
    index: number,
    el: MeasurableVirtualElement,
): void {
    if (!items[index]) return;
    const height = readMeasuredHeight(el);
    if (height > 0) items[index].height = height;
}

export function remeasureMountedVirtualItems(
    items: VirtualItem[],
    mounted: Map<number, MeasurableVirtualElement>,
    virtualizer: Pick<Virtualizer<HTMLElement, HTMLElement>, 'measureElement'> | null,
): void {
    if (!virtualizer) return;
    for (const [index, el] of mounted) {
        syncMeasuredItemHeight(items, index, el);
        virtualizer.measureElement(el as HTMLElement);
    }
}

export class VirtualScroll {
    private items: VirtualItem[] = [];
    private container: HTMLElement;
    private innerEl: HTMLDivElement;
    private _active = false;
    private virtualizer: Virtualizer<HTMLElement, HTMLElement> | null = null;
    private cleanupFn: (() => void) | null = null;
    private mounted = new Map<number, HTMLElement>();
    private itemGap = 0;
    private restorePassTimers = new Set<number>();
    private shouldFollowAfterRestore: RestoreFollowPredicate = () => true;
    private resizePin: ResizePin | null = null;

    onLazyRender: LazyRenderCallback | null = null;
    onPostRender: ((viewport: HTMLElement) => void) | null = null;
    onRecycle: ((element: HTMLElement) => void) | null = null;
    private lifecycleHooks = new Set<VirtualLifecycleHooks>();

    /** Add a stable owner's hooks without replacing caller-owned callbacks. */
    addLifecycleHooks(hooks: VirtualLifecycleHooks): void {
        this.lifecycleHooks.add(hooks);
    }

    private postRender(root: HTMLElement): void {
        this.onPostRender?.(root);
        for (const hooks of this.lifecycleHooks) hooks.postRender(root);
    }

    private recycle(element: HTMLElement): void {
        this.onRecycle?.(element);
        for (const hooks of this.lifecycleHooks) hooks.recycle(element);
    }

    constructor(containerId: string) {
        this.container = document.getElementById(containerId)!;
        this.innerEl = document.createElement('div');
        this.innerEl.className = 'vs-inner';
        this.attachMediaLoadRemeasure();
    }

    /** Lazy media (img/video) finishes loading after its row was measured; remeasure
     *  the owning row so following rows are re-positioned (doc 85 §3). Capture phase:
     *  load/loadedmetadata don't bubble. innerEl is a process-lifetime singleton, so
     *  the listener pair is attached once and never needs cleanup. */
    private attachMediaLoadRemeasure(): void {
        const remeasure = (e: Event) => {
            const target = e.target;
            if (!(target instanceof HTMLImageElement) && !(target instanceof HTMLVideoElement)) return;
            if (!this._active || !this.virtualizer) return;
            const row = target.closest<HTMLElement>('[data-vs-idx]');
            if (!row || !row.isConnected) return;
            syncMeasuredItemHeight(this.items, Number(row.dataset['vsIdx'] || '-1'), row);
            this.virtualizer.measureElement(row);
        };
        this.innerEl.addEventListener('load', remeasure, true);
        this.innerEl.addEventListener('loadedmetadata', remeasure, true);
    }

    get active(): boolean { return this._active; }
    get count(): number { return this.items.length; }

    /** Phase 30 measurement: snapshot of virtualization state for long-session /
     *  huge-block observation. Pure read — no layout side effects. */
    metrics(): {
        virtualItemCount: number;
        mountedRowCount: number;
        firstVisibleIdx: number | null;
        lastVisibleIdx: number | null;
        firstVisibleId: string | null;
        lastVisibleId: string | null;
    } {
        const idxs = [...this.mounted.keys()].sort((a, b) => a - b);
        const first = idxs[0];
        const last = idxs[idxs.length - 1];
        return {
            virtualItemCount: this.items.length,
            mountedRowCount: this.mounted.size,
            firstVisibleIdx: first ?? null,
            lastVisibleIdx: last ?? null,
            firstVisibleId: first !== undefined ? (this.items[first]?.id ?? null) : null,
            lastVisibleId: last !== undefined ? (this.items[last]?.id ?? null) : null,
        };
    }

    private measureGap(): number {
        if (this.itemGap > 0) return this.itemGap;
        const probe = document.createElement('div');
        probe.className = 'msg';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.textContent = ' ';
        this.innerEl.appendChild(probe);
        this.itemGap = parseFloat(getComputedStyle(probe).marginBottom) || 0;
        probe.remove();
        return this.itemGap;
    }

    private invalidateLayout(): void {
        if (!this.virtualizer) return;
        this.itemGap = 0;
        const newGap = this.measureGap();
        this.virtualizer.setOptions({
            ...this.virtualizer.options,
            gap: newGap,
        });
        this.virtualizer.measure();
        remeasureMountedVirtualItems(this.items, this.mounted, this.virtualizer);
        this.renderItems();
    }

    /** Width-driven re-measure that keeps the reader's place for a whole drag.
     *  Follow intent and the anchor are read once, at the first frame: later
     *  frames see scroll events caused by the reflow itself, and TanStack's own
     *  item measurements land a frame after ours, so re-reading either would
     *  compound the drift this exists to remove. */
    private invalidateLayoutPinned(): void {
        if (!this.virtualizer) return;
        let pin = this.resizePin;
        if (!pin) {
            const follow = this.shouldFollowAfterRestore();
            pin = { follow, anchor: follow ? null : this.captureIndexAnchor(), settleTimer: 0 };
            this.resizePin = pin;
        }
        window.clearTimeout(pin.settleTimer);
        this.invalidateLayout();
        this.applyResizePin(pin);
        const settling = pin;
        settling.settleTimer = window.setTimeout(() => {
            requestAnimationFrame(() => {
                if (this.resizePin !== settling) return;
                this.resizePin = null;
                if (this.virtualizer) this.applyResizePin(settling);
            });
        }, RESIZE_SETTLE_MS);
    }

    private applyResizePin(pin: ResizePin): void {
        if (pin.follow) {
            this.scrollToBottom();
            return;
        }
        if (!pin.anchor) return;
        const el = this.mounted.get(pin.anchor.index);
        if (!el?.isConnected) return;
        const delta = el.getBoundingClientRect().top - pin.anchor.top;
        if (Number.isFinite(delta) && delta !== 0) this.container.scrollTop += delta;
    }

    private captureIndexAnchor(): ResizePin['anchor'] {
        const el = this.firstVisibleMountedItem();
        if (!el) return null;
        const index = Number(el.dataset['vsIdx'] ?? '-1');
        return index >= 0 ? { index, top: el.getBoundingClientRect().top } : null;
    }

    private clearResizePin(): void {
        if (this.resizePin) window.clearTimeout(this.resizePin.settleTimer);
        this.resizePin = null;
    }

    /** Bulk-load items. Call AFTER registering onLazyRender/onPostRender. */
    setItems(
        items: VirtualItem[],
        options?: { autoActivate?: boolean; toBottom?: boolean },
    ): void {
        this.items = items;
        if (options?.autoActivate === false) return;
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(options?.toBottom ?? true);
        }
    }

    /** Seed heights so estimateSize is accurate before ResizeObserver runs. */
    seedMeasuredHeights(startIndex: number, heights: number[]): void {
        for (let offset = 0; offset < heights.length; offset++) {
            const idx = startIndex + offset;
            if (this.items[idx]) {
                this.items[idx].height = heights[offset];
            }
        }
    }

    /** Activate if threshold met. */
    activateIfNeeded(toBottom = false): void {
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(toBottom);
        }
    }

    addItem(id: string, html: string): void {
        this.appendItem({ id, html, height: EST_HEIGHT });
    }

    appendItem(item: VirtualItem): void {
        this.items.push(item);
        if (!this._active && this.items.length >= THRESHOLD) {
            this.activate(true);
            return;
        }
        if (this._active && this.virtualizer) {
            this.virtualizer.setOptions({
                ...this.virtualizer.options,
                count: this.items.length,
            });
        }
    }

    appendLiveItem(div: HTMLElement): void {
        if (!this._active) return;
        releaseMermaidNodes(div);
        const html = div.outerHTML;
        const id = generateId();
        const messageId = div.dataset['messageId'];
        this.items.push({ id, ...(messageId ? { messageId } : {}), html, height: EST_HEIGHT });
        if (this.virtualizer) {
            this.virtualizer.setOptions({
                ...this.virtualizer.options,
                count: this.items.length,
            });
            // Promotion must mount even if neither viewport nor scroll offset changed.
            this.renderItems();
        }
    }

    /** Reconcile one uniquely identified row, including an offscreen retained row. */
    reconcileMessage(messageId: string, update: (message: HTMLElement) => void): boolean {
        const index = this.items.findIndex(item => item.messageId === messageId);
        if (index < 0 || this.items.some((item, i) => i !== index && item.messageId === messageId)) return false;
        const item = this.items[index]!;
        const mounted = this.mounted.get(index);
        const wrapper = this.container.ownerDocument.createElement('div');
        if (!mounted) wrapper.innerHTML = item.html;
        const message = mounted ?? wrapper.firstElementChild as HTMLElement | null;
        if (!message || message.dataset['messageId'] !== messageId) return false;
        update(message);
        item.html = message.outerHTML;
        if (mounted && this.virtualizer) {
            syncMeasuredItemHeight(this.items, index, mounted);
            this.virtualizer.measureElement(mounted);
        }
        return true;
    }

    updateItemHtml(idx: number, html: string): void {
        if (this.items[idx]) {
            this.items[idx].html = html;
        }
    }

    scrollToBottom(): void {
        if (this._active && this.virtualizer && this.items.length > 0) {
            this.virtualizer.scrollToIndex(this.items.length - 1, { align: 'end' });
        }
        // Keep DOM scrollTop as the final source so streaming placeholder
        // content outside VS is still reachable.
        this.container.scrollTop = this.container.scrollHeight;
    }

    firstVisibleIndex(): number | null {
        if (!this._active || !this.virtualizer) return null;
        const virtualItems = this.virtualizer.getVirtualItems();
        if (virtualItems.length === 0) return null;
        const containerTop = this.container.scrollTop;
        for (const vi of virtualItems) {
            if (vi.end > containerTop) return vi.index;
        }
        return virtualItems[0].index;
    }

    scrollToIndex(index: number, align: 'start' | 'center' | 'end' = 'start'): void {
        if (this._active && this.virtualizer && index >= 0 && index < this.items.length) {
            this.virtualizer.scrollToIndex(index, { align });
        }
    }

    isNearBottom(threshold = BOTTOM_THRESHOLD): boolean {
        const dist = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
        return dist < threshold;
    }

    setRestoreFollowPredicate(predicate: RestoreFollowPredicate | null): void {
        this.shouldFollowAfterRestore = predicate ?? (() => true);
    }

    reconcileBottomAfterLayout(reason: RestoreReason, shouldFollow = this.isNearBottom()): void {
        if (!shouldFollow) return;
        void reason;
        requestAnimationFrame(() => {
            this.invalidateLayout();
            requestAnimationFrame(() => {
                this.scrollToBottom();
            });
        });
    }

    reconcileAfterRestore(reason: RestoreReason, shouldFollow: RestoreFollowPredicate = this.shouldFollowAfterRestore): void {
        if (!shouldFollow()) {
            this.invalidateLayout();
            return;
        }
        this.scheduleRestoreReconcile(reason, shouldFollow);
    }

    forceBottomAfterRestore(reason: RestoreReason): void {
        this.scheduleRestoreReconcile(reason);
    }

    cancelRestoreReconcile(_reason?: RestoreReason): void {
        this.clearRestoreTimers();
    }

    preserveScrollDuringMutation<T>(anchorEl: Element | null, mutate: () => T): T {
        const wasNearBottom = this.isNearBottom();
        const anchor = this.captureScrollAnchor(anchorEl);
        const result = mutate();
        this.invalidateLayout();
        if (wasNearBottom) {
            this.reconcileBottomAfterLayout('manual', true);
            return result;
        }
        this.restoreScrollAnchor(anchor);
        return result;
    }

    private scheduleRestoreReconcile(reason: RestoreReason, shouldFollow?: RestoreFollowPredicate): void {
        this.runRestoreReconcilePass(reason, shouldFollow);
        requestAnimationFrame(() => this.runRestoreReconcilePass(reason, shouldFollow));
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this.runRestoreReconcilePass(reason, shouldFollow));
        });
        this.scheduleRestoreTimer(reason, 250, shouldFollow);
        this.scheduleRestoreTimer(reason, 1000, shouldFollow);
        void document.fonts?.ready.then(() => this.runRestoreReconcilePass(reason, shouldFollow));
    }

    private scheduleRestoreTimer(reason: RestoreReason, delayMs: number, shouldFollow?: RestoreFollowPredicate): void {
        const timer = window.setTimeout(() => {
            this.restorePassTimers.delete(timer);
            this.runRestoreReconcilePass(reason, shouldFollow);
        }, delayMs);
        this.restorePassTimers.add(timer);
    }

    private runRestoreReconcilePass(reason: RestoreReason, shouldFollow?: RestoreFollowPredicate): void {
        if (!this.virtualizer) return;
        void reason;
        if (shouldFollow && !shouldFollow()) {
            this.cancelRestoreReconcile(reason);
            this.invalidateLayout();
            return;
        }
        this.invalidateLayout();
        remeasureMountedVirtualItems(this.items, this.mounted, this.virtualizer);
        this.scrollToBottom();
    }

    private captureScrollAnchor(preferred: Element | null): ScrollAnchor | null {
        const preferredEl = preferred instanceof HTMLElement ? preferred : null;
        const chosen = preferredEl && this.isVisibleInContainer(preferredEl)
            ? preferredEl
            : this.firstVisibleMountedItem();
        return chosen ? { el: chosen, top: chosen.getBoundingClientRect().top } : null;
    }

    private restoreScrollAnchor(anchor: ScrollAnchor | null): void {
        if (!anchor || !anchor.el.isConnected) return;
        const afterTop = anchor.el.getBoundingClientRect().top;
        const delta = afterTop - anchor.top;
        if (Number.isFinite(delta) && delta !== 0) {
            this.container.scrollTop += delta;
        }
    }

    private firstVisibleMountedItem(): HTMLElement | null {
        const mounted = Array.from(this.mounted.entries()).sort(([a], [b]) => a - b);
        for (const [, el] of mounted) {
            if (this.isVisibleInContainer(el)) return el;
        }
        return null;
    }

    private isVisibleInContainer(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();
        return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    }

    private clearRestoreTimers(): void {
        for (const timer of this.restorePassTimers) {
            window.clearTimeout(timer);
        }
        this.restorePassTimers.clear();
    }

    flushToDOM(): void {
        if (!this._active) return;
        this.deactivate();
        this.container.innerHTML = this.items.map(it => it.html).join('');
        this.postRender(this.container);
        this.items = [];
    }

    clear(): void {
        this.deactivate();
        this.items = [];
        this.itemGap = 0;
        this.onLazyRender = null;
        this.onPostRender = null;
        this.onRecycle = null;
        this.lifecycleHooks.clear();
    }

    // ── Activation / Deactivation ──

    private activate(toBottom = false): void {
        this._active = true;

        // Measure real heights from existing DOM before replacing. A hidden
        // container measures 0 — keep the EST_HEIGHT seed instead of poisoning
        // every item with a zero estimate (same guard as syncMeasuredItemHeight).
        const existing = this.container.querySelectorAll('.msg');
        existing.forEach((el, i) => {
            if (!this.items[i]) return;
            const measured = el.getBoundingClientRect().height;
            if (measured > 0) this.items[i].height = measured;
        });

        this.container.classList.add('vs-active');
        this.container.replaceChildren(this.innerEl);

        // Measure gap after .vs-active is applied
        this.measureGap();

        this.virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
            count: this.items.length,
            getScrollElement: () => this.container,
            estimateSize: (i: number) => this.items[i]?.height ?? EST_HEIGHT,
            overscan: OVERSCAN,
            gap: this.itemGap,
            // Our post-render pipeline mutates the mounted message DOM
            // (markdown lazy render, widgets, linkification). Defer RO-driven
            // measurements by one frame to avoid "ResizeObserver loop completed
            // with undelivered notifications" during those mutations.
            useAnimationFrameWithResizeObserver: true,
            onChange: () => this.renderItems(),
            observeElementRect,
            observeElementOffset,
            scrollToFn: elementScroll,
            getItemKey: (i: number) => this.items[i]?.id ?? i,
            indexAttribute: 'data-vs-idx',
        });

        const cleanupFns: Array<() => void> = [];
        const mountCleanup = this.virtualizer._didMount();
        if (mountCleanup) cleanupFns.push(mountCleanup);

        // ── Resize invalidation ──
        // When viewport width changes, message text reflows and heights change.
        // TanStack's ResizeObserver watches individual items, but not the
        // container width — a window resize doesn't trigger item RO callbacks
        // because items are position:absolute (width from left:0 + right:0).
        // Re-measuring alone leaves scrollTop wherever the height deltas put it,
        // so a drag (Manager sidebar, window edge) drifts a few px per frame
        // until chat-scroll reads the gap as "user scrolled up" and stops
        // following. Re-pin every pass: bottom while following, else the first
        // visible row's on-screen top.
        let resizeRaf = 0;
        const scheduleInvalidateLayout = () => {
            cancelAnimationFrame(resizeRaf);
            resizeRaf = requestAnimationFrame(() => {
                this.invalidateLayoutPinned();
            });
        };
        const onResize = () => scheduleInvalidateLayout();
        window.addEventListener('resize', onResize);
        cleanupFns.push(() => {
            window.removeEventListener('resize', onResize);
            cancelAnimationFrame(resizeRaf);
            this.clearResizePin();
        });

        if (typeof ResizeObserver !== 'undefined') {
            let prevWidth = this.container.clientWidth;
            let prevHeight = this.container.clientHeight;
            const containerObserver = new ResizeObserver((entries) => {
                const rect = entries[0]?.contentRect;
                if (!rect) return;
                const width = Math.round(rect.width);
                const height = Math.round(rect.height);
                if (width === prevWidth && height === prevHeight) return;
                prevWidth = width;
                prevHeight = height;
                scheduleInvalidateLayout();
            });
            containerObserver.observe(this.container);
            cleanupFns.push(() => containerObserver.disconnect());

            // ── Content-growth bottom lock ──
            // innerEl height tracks the virtualizer total size (set in render).
            // Lazy markdown / mermaid / images grow it *after* the time-boxed
            // initial settle finishes, drifting the bottom anchor upward with
            // nothing left to re-bottom. Re-bottom when total content height
            // grows — but only while bottom-follow intent still holds, so it
            // releases the moment the user scrolls up (260508 rule preserved).
            let prevTotal = this.virtualizer?.getTotalSize() ?? 0;
            const contentObserver = new ResizeObserver(() => {
                const total = this.virtualizer?.getTotalSize() ?? 0;
                if (total <= prevTotal) { prevTotal = total; return; }
                prevTotal = total;
                if (this.shouldFollowAfterRestore()) {
                    this.reconcileBottomAfterLayout('manual', true);
                }
            });
            contentObserver.observe(this.innerEl);
            cleanupFns.push(() => contentObserver.disconnect());
        }

        // ── Browser restore reconciliation ──
        // Resume/discard paths can restore stale virtualizer measurements.
        const restoreBottomAfterLayout = (reason: RestoreReason) => {
            if (!this.virtualizer) return;
            this.reconcileAfterRestore(reason, this.shouldFollowAfterRestore);
        };
        const onPageShow = (e: PageTransitionEvent) => {
            if (!e.persisted) return;
            restoreBottomAfterLayout('pageshow');
        };
        window.addEventListener('pageshow', onPageShow);
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            restoreBottomAfterLayout('visibility');
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        const onFocus = () => restoreBottomAfterLayout('focus');
        window.addEventListener('focus', onFocus);
        const onResume = () => restoreBottomAfterLayout('resume');
        document.addEventListener('resume', onResume);
        const onPageHide = () => { /* diagnostic hook: restore happens on pageshow/resume */ };
        window.addEventListener('pagehide', onPageHide);
        const onFreeze = () => { /* diagnostic hook: restore happens on resume */ };
        document.addEventListener('freeze', onFreeze);
        this.cleanupFn = () => {
            window.removeEventListener('pageshow', onPageShow);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('resume', onResume);
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('freeze', onFreeze);
            for (const cleanup of cleanupFns.reverse()) cleanup();
            this.clearRestoreTimers();
        };

        this.virtualizer._willUpdate();

        if (toBottom && this.items.length > 0) {
            // Hide during initial settle — scrollToIndex reconciliation
            // takes 1-2 RAF frames to converge
            this.container.style.opacity = '0';
            this.renderItems();
            // Use TanStack API — sets internal scrollState + DOM scrollTop
            // together, then reconciliation loop auto-corrects as items
            // get measured with real heights
            this.virtualizer.scrollToIndex(this.items.length - 1, { align: 'end' });
            // Show after reconciliation settles
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.container.style.opacity = '';
                });
            });
        } else {
            this.renderItems();
        }
        const wasDiscarded = 'wasDiscarded' in document
            && Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded);
        if (wasDiscarded) {
            restoreBottomAfterLayout('discard');
        }
    }

    private deactivate(): void {
        this.clearRestoreTimers();
        if (this.cleanupFn) {
            this.cleanupFn();
            this.cleanupFn = null;
        }
        this.virtualizer = null;
        this._active = false;
        for (const el of this.mounted.values()) {
            this.recycle(el);
            releaseMermaidNodes(el);
            releaseProcessBlockDetails(el);
        }
        this.mounted.clear();
        // innerEl is a reused singleton: emptying the container detaches it but
        // leaves its children alive. Without this, the next activate() re-attaches
        // those ghosts at stale translateY offsets UNDER the new items (mounted was
        // cleared, so renderItems can never unmount them) — every reconnect reload
        // stacked one more overlapping copy of the history.
        this.innerEl.replaceChildren();
        this.container.classList.remove('vs-active');
        this.container.innerHTML = '';
    }

    private renderItems(): void {
        if (!this.virtualizer) return;
        this.virtualizer._willUpdate();

        const virtualItems = this.virtualizer.getVirtualItems();
        const totalSize = this.virtualizer.getTotalSize();

        this.innerEl.style.height = `${totalSize}px`;

        const wantedSet = new Set(virtualItems.map(vi => vi.index));

        for (const [idx, el] of this.mounted) {
            if (!wantedSet.has(idx)) {
                this.recycle(el);
                releaseMermaidNodes(el);
                const item = this.items[idx];
                if (item?.rehydratesProcessDetails) releaseProcessBlockDetails(el);
                el.remove();
                this.mounted.delete(idx);
            }
        }

        const newlyMounted: HTMLElement[] = [];
        for (const vItem of virtualItems) {
            let el = this.mounted.get(vItem.index);

            if (!el) {
                const item = this.items[vItem.index];
                if (!item) continue;
                const wrapper = document.createElement('div');
                wrapper.innerHTML = item.html;
                el = wrapper.firstElementChild as HTMLElement;
                if (!el) continue;
                el.dataset['vsIdx'] = String(vItem.index);
                this.innerEl.appendChild(el);
                this.mounted.set(vItem.index, el);
                newlyMounted.push(el);
            }

            // CSS owns left/right/width, including .msg-user alignment.
            el.style.transform = `translateY(${vItem.start}px)`;
        }

        // Absolute positioning does not determine reading or keyboard order.
        // Put new older rows before retained rows without replacing their hosts.
        const focused = this.innerEl.contains(document.activeElement)
            ? document.activeElement as HTMLElement : null;
        let cursor = this.innerEl.firstElementChild;
        for (const vItem of virtualItems) {
            const el = this.mounted.get(vItem.index);
            if (!el) continue;
            if (el !== cursor) this.innerEl.insertBefore(el, cursor);
            cursor = el.nextElementSibling;
        }
        if (focused?.isConnected && document.activeElement !== focused) {
            focused.focus({ preventScroll: true });
        }

        // Lazy render before measuring; markdown/code/math change heights.
        if (this.onLazyRender) {
            const lazyTargets = this.innerEl.querySelectorAll<HTMLElement>('.lazy-pending');
            if (lazyTargets.length > 0) {
                this.onLazyRender(Array.from(lazyTargets));
            }
        }

        this.postRender(this.innerEl);

        // Newly mounted elements now have their final rendered content.
        for (const el of newlyMounted) {
            const index = Number(el.dataset['vsIdx'] || '-1');
            syncMeasuredItemHeight(this.items, index, el);
            this.virtualizer!.measureElement(el);
        }
    }
}

let instance: VirtualScroll | null = null;

export function getVirtualScroll(): VirtualScroll {
    if (!instance) {
        instance = new VirtualScroll('chatMessages');
    }
    return instance;
}

export { THRESHOLD as VS_THRESHOLD };
