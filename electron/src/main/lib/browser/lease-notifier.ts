import { randomUUID } from 'node:crypto';

export type LeaseDocument = { authorityId: string; ownerId: string; generation: number };
export type LeaseMount = LeaseDocument & { mountSeq: number };
export type LeaseRevokeBody =
  | (LeaseDocument & { reason: string })
  | (LeaseDocument & { guestEpoch: number; webContentsIds: number[]; reason: string });
export type LeasePostResult = number | 'network-error';

type WindowState = { ownerId: string; generation: number; latestMount: number | null; released: Set<number>; closed: boolean };
type QueueItem = { body: LeaseRevokeBody; done: Promise<void>; resolve: () => void };

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function isDocument(value: unknown): value is LeaseDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as LeaseDocument;
  return validId(v.authorityId) && validId(v.ownerId) && positiveInteger(v.generation);
}
function isMount(value: unknown): value is LeaseMount {
  return isDocument(value) && positiveInteger((value as LeaseMount).mountSeq);
}

export class TargetLeaseAuthority {
  readonly authorityId = randomUUID();
  private readonly windows = new Map<number, WindowState>();
  private readonly queue: QueueItem[] = [];
  private generation = 0;
  private mountSeq = 0;
  private epoch = 0;
  private delivering = false;
  private readonly post: (body: LeaseRevokeBody) => Promise<LeasePostResult>;
  private readonly log: (line: string) => void;
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly grantWaitMs: number;

  constructor(opts: { post: (body: LeaseRevokeBody) => Promise<LeasePostResult>; log?: (line: string) => void; backoff?: { initialMs: number; maxMs: number }; grantWaitMs?: number }) {
    this.post = opts.post;
    this.log = opts.log ?? (() => {});
    this.backoff = opts.backoff ?? { initialMs: 200, maxMs: 2000 };
    this.grantWaitMs = opts.grantWaitMs ?? 5000;
  }
  get guestEpoch(): number { return this.epoch; }

  beginDocument(windowKey: number): LeaseDocument {
    let state = this.windows.get(windowKey);
    if (state?.closed) throw new Error('window closed');
    if (state) this.revokeWindow(windowKey, 'document-replaced');
    else {
      state = { ownerId: randomUUID(), generation: 0, latestMount: null, released: new Set(), closed: false };
      this.windows.set(windowKey, state);
    }
    state.generation = ++this.generation;
    state.latestMount = null;
    state.released.clear();
    return { authorityId: this.authorityId, ownerId: state.ownerId, generation: state.generation };
  }

  private matches(windowKey: number, doc: unknown): doc is LeaseDocument {
    const state = this.windows.get(windowKey);
    return !!state && !state.closed && isDocument(doc) && doc.authorityId === this.authorityId && doc.ownerId === state.ownerId && doc.generation === state.generation;
  }

  async acquireMount(windowKey: number, doc: unknown): Promise<({ ok: true } & LeaseMount) | { ok: false; retryable?: boolean; error: string }> {
    if (!this.matches(windowKey, doc)) return { ok: false, error: 'stale lease document' };
    const pending = this.queue.map(item => item.done);
    if (pending.length && !await this.waitFor(Promise.all(pending), this.grantWaitMs)) {
      return { ok: false, retryable: true, error: 'lease revoke pending' };
    }
    if (!this.matches(windowKey, doc)) return { ok: false, error: 'stale lease document' };
    const mountSeq = ++this.mountSeq;
    this.windows.get(windowKey)!.latestMount = mountSeq;
    return { ok: true, authorityId: doc.authorityId, ownerId: doc.ownerId, generation: doc.generation, mountSeq };
  }
  releaseMount(windowKey: number, mount: unknown): boolean {
    if (!isMount(mount) || !this.matches(windowKey, mount)) return false;
    this.windows.get(windowKey)!.released.add(mount.mountSeq);
    return true;
  }
  isMountActive(windowKey: number, mount: unknown): boolean {
    if (!isMount(mount) || !this.matches(windowKey, mount)) return false;
    const state = this.windows.get(windowKey)!;
    return state.latestMount === mount.mountSeq && !state.released.has(mount.mountSeq);
  }
  revokeWindow(windowKey: number, reason: string): void {
    const state = this.windows.get(windowKey);
    if (!state || state.closed) return;
    this.enqueue({ authorityId: this.authorityId, ownerId: state.ownerId, generation: state.generation, reason });
  }
  closeWindow(windowKey: number, reason: string): void {
    const state = this.windows.get(windowKey);
    if (!state || state.closed) return;
    this.revokeWindow(windowKey, reason);
    state.closed = true;
  }
  revokeGuest(windowKey: number, webContentsId: number): void {
    const state = this.windows.get(windowKey);
    if (!state || state.closed || !positiveInteger(webContentsId)) return;
    this.enqueue({ authorityId: this.authorityId, ownerId: state.ownerId, generation: state.generation, guestEpoch: ++this.epoch, webContentsIds: [webContentsId], reason: 'guest-destroyed' });
  }
  async flush(timeoutMs: number): Promise<void> {
    await this.waitFor(Promise.all(this.queue.map(item => item.done)), timeoutMs);
  }
  private waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void promise.then(() => { clearTimeout(timer); resolve(true); });
    });
  }
  private enqueue(body: LeaseRevokeBody): void {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    this.queue.push({ body, done, resolve });
    if (!this.delivering) void this.deliver();
  }
  private async deliver(): Promise<void> {
    this.delivering = true;
    let wait = this.backoff.initialMs;
    while (this.queue.length) {
      const item = this.queue[0];
      let result: LeasePostResult;
      try { result = await this.post(item.body); } catch { result = 'network-error'; }
      if (result === 'network-error' || result >= 500) {
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, wait); timer.unref?.(); });
        wait = Math.min(this.backoff.maxMs, wait * 2);
        continue;
      }
      if (result < 200 || result >= 300) this.log(`[browser lease] revoke returned ${result}\n`);
      this.queue.shift();
      item.resolve();
      wait = this.backoff.initialMs;
    }
    this.delivering = false;
  }
}

export function createLeaseRevokePoster(opts: { managerUrl: () => string; token: string | (() => string); fetchImpl?: typeof fetch; timeoutMs?: number }): (body: LeaseRevokeBody) => Promise<LeasePostResult> {
  return async body => {
    try {
      const response = await (opts.fetchImpl ?? fetch)(new URL('api/manager/embedded-browser/lease/revoke', opts.managerUrl()), {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-CLI-Jaw-Electron': typeof opts.token === 'function' ? opts.token() : opts.token },
        // Allow the server's longer shutdown cleanup to finish before aborting.
        body: JSON.stringify(body), signal: AbortSignal.timeout(body.reason === 'app-quit' ? 10000 : (opts.timeoutMs ?? 3000)),
      });
      return response.status;
    } catch { return 'network-error'; }
  };
}

export function attachManagerWindowLease(authority: TargetLeaseAuthority, windowKey: number, contents: { on(event: 'render-process-gone', fn: (...args: unknown[]) => void): unknown }, win: { on(event: 'closed', fn: () => void): unknown }): void {
  contents.on('render-process-gone', () => authority.revokeWindow(windowKey, 'render-process-gone'));
  win.on('closed', () => authority.closeWindow(windowKey, 'window-closed'));
}
