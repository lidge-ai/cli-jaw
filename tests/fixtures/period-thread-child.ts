import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePeriodThreadRoot } from '../../src/memory/period-thread-root.ts';
import { capturePeriodKey } from '../../src/memory/period-thread-key.ts';
import { acquirePeriodConsumerSlot } from '../../src/memory/period-thread-state.ts';

const [mode, logFile] = process.argv.slice(2);
if (!logFile) throw new Error('log file required');
const append = (value: string) => fs.appendFileSync(logFile, `${value}\n`);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

if (mode === 'create') {
    const captured = capturePeriodKey(Date.UTC(2026, 9, 7, 3), 'day');
    const ts = String(captured.startMs / 1000 + 60);
    const destination = { channel: 'slack' as const, targetId: 'C0TESTCHANNEL', scope: 'period_thread' as const,
        periodThread: { rootKey: 'child-root', period: 'day' as const, role: 'creator' as const, slot: 'slot', title: 'Test period' } };
    const fetchImpl = async (input: RequestInfo | URL) => {
        const method = String(input).split('/').pop();
        if (method === 'conversations.history') return Response.json({ ok: true, messages: [], has_more: false });
        if (method === 'chat.postMessage') { append('POST'); await wait(200); return Response.json({ ok: true, ts }); }
        if (method === 'conversations.replies') return Response.json({ ok: true, messages: [{ ts, user: 'U0TESTBOT', text: `Test period ${captured.label}` }] });
        throw new Error('unexpected method');
    };
    const result = await ensurePeriodThreadRoot(destination, captured, { token: 'fake-token',
        fetchImpl: fetchImpl as typeof fetch, now: () => captured.startMs + 60_000,
        verifyWorkspace: async () => ({ teamId: 'T0TESTTEAM', userId: 'U0TESTBOT' }) });
    process.stdout.write(JSON.stringify(result));
} else if (mode === 'slot') {
    const ready = `${logFile}.ready`;
    fs.appendFileSync(ready, `${process.pid}\n`);
    while (fs.readFileSync(ready, 'utf8').trim().split('\n').length < 3) await wait(10);
    const release = await acquirePeriodConsumerSlot(2, 8);
    if (!release) throw new Error('slot unavailable');
    append(`start ${process.pid} ${Date.now()}`);
    await wait(1500);
    append(`end ${process.pid} ${Date.now()}`);
    release();
} else if (mode === 'dead') {
    const file = path.join(process.env['CLI_JAW_SHARED_HOME']!, 'period-threads', 'slots', 'seq.99999');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: 99999999, host: os.hostname(), token: 'dead', at: 1 }), { mode: 0o600 });
    const release = await acquirePeriodConsumerSlot(1, 0);
    if (!release) throw new Error('dead pid blocked slot');
    release();
    process.stdout.write('ok');
} else throw new Error('unknown fixture mode');
