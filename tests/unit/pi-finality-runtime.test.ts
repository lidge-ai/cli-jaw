import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPiRpc, spawnPersistentPiRpc, DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS } from '../../src/agent/pi-runtime.ts';
import { PiTurnAccumulator, PiRuntimeError, piFailureOutcome, piSupportsSettled } from '../../src/agent/runtime/pi-turn.ts';
import { FULLTEXT_MAX_CHARS } from '../../src/agent/events/fulltext-bound.ts';
import { MAX_PENDING_LINE_CHARS } from '../../src/agent/spawn/line-buffer.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-finality-'));
const binary = join(root, 'pi.mjs');
const eventsFile = join(root, 'events.json');
writeFileSync(binary, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log(process.env.PI_FINALITY_VERSION || '0.83.0'); if(process.env.PI_FINALITY_WARNING) console.error('fixture warning'); process.exit(Number(process.env.PI_FINALITY_VERSION_EXIT || 0)); }
const deadline = setTimeout(() => process.exit(97), 6000);
const send = row => console.log(JSON.stringify(row));
for await (const line of readline.createInterface({input:process.stdin})) {
 const request = JSON.parse(line);
 if (request.type === 'get_state') send({type:'response',command:'get_state',id:request.id,success:true,data:{sessionId:'private-fixture-session'}});
 if (request.type === 'prompt') {
   const rows = JSON.parse(readFileSync(process.env.PI_FINALITY_EVENTS,'utf8'));
   for (const row of rows) send(row.id === '$prompt' ? {...row,id:request.id} : row);
 }
 if (request.type === 'test_settle') send({type:'agent_settled'});
 if (request.type === 'test_events') for(const row of request.events) send(row);
 if (request.type === 'abort') {
   send({type:'response',command:'abort',id:request.id,success:true});
   send({type:'agent_end',messages:[{role:'assistant',content:[],stopReason:'aborted'}],willRetry:false});
   send({type:'agent_settled'});
 }
}
clearTimeout(deadline);
`);
chmodSync(binary, 0o755);
const prior = {bin:process.env.PI_CODING_AGENT_BIN,events:process.env.PI_FINALITY_EVENTS,version:process.env.PI_FINALITY_VERSION};
process.env.PI_CODING_AGENT_BIN = binary;
process.env.PI_FINALITY_EVENTS = eventsFile;
test.after(() => {
    for (const [key, value] of Object.entries({PI_CODING_AGENT_BIN:prior.bin,PI_FINALITY_EVENTS:prior.events,PI_FINALITY_VERSION:prior.version})) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, {recursive:true,force:true});
});
const assistant = (text: string | null, stopReason = 'stop', tool = false) => ({role:'assistant',stopReason,
    content:[...(text === null ? [] : [{type:'text',text}]), ...(tool ? [{type:'toolCall',id:'private-tool',name:'bash',arguments:{command:'printf fixture'}}] : [])]});
const delta = (text: string) => ({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
const end = (messages: unknown[]) => ({type:'agent_end',messages,willRetry:false});
const settled = {type:'agent_settled'};
function configure(rows: unknown[], version = '0.83.0') {
    writeFileSync(eventsFile, JSON.stringify(rows)); process.env.PI_FINALITY_VERSION = version;
}
async function direct(rows: unknown[], rawThrows = false, version = '0.83.0') {
    configure(rows, version);
    const accepted: string[] = [];
    const run = spawnPiRpc(DEFAULT_PI_PROFILE, DEFAULT_PI_SETTINGS, {prompt:'fixture',model:'fixture',cwd:root,root,
        onEvent:event => {if(event.kind==='text') accepted.push(event.text);},
        onRawRecord:rawThrows ? () => {throw new Error('journal unavailable');} : undefined});
    const closed = once(run.child,'close');
    const timeout = setTimeout(() => run.child.kill('SIGTERM'), 5000);
    try { const result = await run.done; await closed; return {result,accepted:accepted.join('')}; }
    finally { clearTimeout(timeout); run.child.kill(); }
}
const pre = assistant('Starting the read-only probe.', 'toolUse', true);
const final = assistant('PI_ACTIVITY_DONE');
const probe = [
    {type:'agent_start'}, {type:'message_start',message:pre}, delta('Starting the read-only probe.'),
    {type:'message_end',message:pre}, {type:'turn_end',message:pre,toolResults:[]},
    {type:'message_start',message:final},delta('PI_ACTIVITY_DONE'),{type:'message_end',message:final},
    {type:'turn_end',message:final,toolResults:[]},end([pre,final]),settled,
];

test('typed Pi finality excludes pre-tool commentary and preserves accepted text once', { timeout: 10000 }, async () => {
    const {result,accepted} = await direct(probe);
    assert.deepEqual(Reflect.get(result,'runtimeOutcome'), {status:'done',finalText:'PI_ACTIVITY_DONE',partialText:'Starting the read-only probe.PI_ACTIVITY_DONE'});
    assert.equal(accepted,'Starting the read-only probe.PI_ACTIVITY_DONE');
});

function accumulate(rows: unknown[], modern = true) {
    const turn = new PiTurnAccumulator(modern);
    const accepted: string[] = [];
    for (const row of rows) accepted.push(turn.observe(row).text);
    return {outcome:turn.snapshot(),accepted:accepted.join('')};
}
for (const text of [null, '', ' \n\t ', 'FINAL']) {
    test(`Pi final preserves ${JSON.stringify(text)} separately from pre-tool partial`, () => {
        const result = accumulate([end([pre,assistant(text)]),settled]);
        assert.deepEqual(result.outcome,{status:'done',finalText:text,partialText:pre.content[0]!.text + (text ?? '')});
    });
}
for (const [reason,status] of [['error','error'],['aborted','stopped'],['length','error'],['pending','error'],['unknown','error'],['toolUse','done']]) {
    test(`latest assistant ${reason} never promotes earlier completed answer`, () => {
        const result = accumulate([end([assistant('old answer'),assistant('/goal done',reason)]),settled]);
        assert.deepEqual(result.outcome,{status,finalText:null,partialText:'old answer/goal done'});
    });
}
test('stop with toolCall and reasoning-only stop cannot manufacture a final', () => {
    assert.equal(accumulate([end([assistant('commentary','stop',true)]),settled]).outcome.finalText,null);
    const result = accumulate([end([{role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'private reason'}]}]),settled]);
    assert.deepEqual(result.outcome,{status:'done',finalText:null,partialText:''});
    assert.deepEqual(accumulate([end([{role:'toolResult',content:[{type:'text',text:'tool only'}]}]),settled]).outcome,
        {status:'done',finalText:null,partialText:''});
});
test('distinct identical messages and mixed streamed/snapshot messages keep each occurrence once', () => {
    const same = assistant('same');
    const result = accumulate([{type:'message_start',message:same},delta('sa'),{type:'message_end',message:same},
        {type:'turn_end',message:same},{type:'message_start',message:same},delta('s'),end([same,same]),settled]);
    assert.equal(result.accepted,'samesame');
    assert.deepEqual(result.outcome,{status:'done',finalText:'same',partialText:'samesame'});
    assert.equal(accumulate([delta('same'),end([same,same]),end([same,same]),settled]).accepted,'samesame');
});
test('failure-only terminal retains earlier partial but invalidates prior successful candidate', () => {
    const result = accumulate([{type:'message_start',message:final},delta('PI_ACTIVITY_DONE'),
        {type:'message_end',message:final},end([assistant(null,'error')]),settled]);
    assert.deepEqual(result.outcome,{status:'error',finalText:null,partialText:'PI_ACTIVITY_DONE'});
});
test('unknown control records and post-settlement events cannot rewrite a final', () => {
    const result = accumulate([end([final]),settled,delta('late'),end([assistant('late')]),
        {type:'mystery',text:'/goal done',messages:[assistant('wrong')]}]);
    assert.deepEqual(result.outcome,{status:'done',finalText:'PI_ACTIVITY_DONE',partialText:'PI_ACTIVITY_DONE'});
});
test('malformed agent_end cannot mask an explicit error or stopped outcome', () => {
    for (const [reason,status] of [['error','error'],['aborted','stopped']]) {
        const result=accumulate([{type:'message_end',message:assistant('partial',reason)},
            {type:'agent_end',messages:'invalid'},settled]);
        assert.deepEqual(result.outcome,{status,finalText:null,partialText:'partial'});
    }
});
test('terminal arrays without an assistant cannot erase prior error or abort', () => {
    for (const [reason,status] of [['error','error'],['aborted','stopped']]) {
        for (const messages of [[],[null],[{role:'toolResult',content:[]}]]) {
            const result=accumulate([{type:'message_end',message:assistant('partial',reason)},end(messages),settled]);
            assert.deepEqual(result.outcome,{status,finalText:null,partialText:'partial'});
        }
    }
});
test('malformed assistant content cannot claim a successful typed final', () => {
    for (const content of [null,'raw text',[{type:'text',text:1}],[{type:'future-control',text:'FINAL'}]]) {
        const result=accumulate([end([{role:'assistant',stopReason:'stop',content}]),settled]);
        assert.equal(result.outcome.status,'error');assert.equal(result.outcome.finalText,null);
    }
});
test('partial cap survives oversized deltas and repeated terminal echoes', () => {
    const text = 'x'.repeat(FULLTEXT_MAX_CHARS+1);
    const result = accumulate([delta(text),end([assistant(text)]),end([assistant(text)]),settled]);
    assert.equal(result.accepted.length,FULLTEXT_MAX_CHARS);
    assert.equal(result.outcome.partialText.length,FULLTEXT_MAX_CHARS);
    assert.equal(result.outcome.finalText,null,'oversized final is not silently truncated into success');
    assert.equal(result.outcome.status,'error');
});
test('modern retry/followup keeps overall salvage and takes the final low-level run', () => {
    const turn = new PiTurnAccumulator(true);
    turn.observe({type:'agent_start'}); turn.observe(delta('failed attempt'));
    assert.equal(turn.observe({...end([assistant('failed attempt','error')]),willRetry:true}).done,false);
    turn.observe({type:'agent_start'}); turn.observe(delta('intermediate'));
    assert.equal(turn.observe(end([assistant('intermediate')])).done,false);
    turn.observe({type:'agent_start'}); turn.observe(delta('final followup'));
    turn.observe(end([assistant('final followup')]));
    assert.equal(turn.observe(settled).done,true);
    assert.deepEqual(turn.snapshot(),{status:'done',finalText:'final followup',partialText:'failed attemptintermediatefinal followup'});
});
test('settled capability uses the verified version boundary, not willRetry presence', () => {
    for(const version of ['0.80.4','0.83.0','pi v0.81.0','1.0.0']) assert.equal(piSupportsSettled(version),true,version);
    for(const version of ['0.75.4','0.80.3','0.80.4-beta','fake-pi 1.0.0','unknown']) assert.equal(piSupportsSettled(version),false,version);
    const old = new PiTurnAccumulator(false);
    assert.equal(old.observe({...end([assistant('retry','error')]),willRetry:true}).done,false);
    old.observe({type:'agent_start'});
    assert.equal(old.observe(end([final])).done,true);
});
test('failure carrier accepts only local owned snapshots', () => {
    const original = new Error('original');
    const outcome = {status:'error' as const,finalText:null,partialText:'partial'};
    const error = new PiRuntimeError(original,outcome); outcome.partialText = 'mutated';
    assert.equal(error.cause,original);
    assert.equal(piFailureOutcome(error)?.partialText,'partial');
    assert.equal(piFailureOutcome(Object.assign(new Error('foreign'),{runtimeOutcome:outcome})),undefined);
    assert.equal(piFailureOutcome(Object.create(error)),undefined);
});
test('raw observer failure leaves final and salvage intact', { timeout: 10000 }, async context => {
    context.mock.method(console,'warn',() => {});
    const {result,accepted} = await direct(probe,true);
    assert.equal(result.runtimeOutcome?.finalText,'PI_ACTIVITY_DONE');
    assert.equal(result.runtimeOutcome?.partialText,accepted);
});
for (const warning of [false,true]) test(`modern persistent prompt waits for settled despite version stderr warning=${warning}`, { timeout: 10000 }, async () => {
    if(warning) process.env.PI_FINALITY_WARNING='1';
    configure([end([pre,final])]);
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE,DEFAULT_PI_SETTINGS,{model:'fixture',cwd:root,root});
    const closed = once(session.child,'close');
    let lowEnd!: () => void;
    const ended = new Promise<void>(resolve => {lowEnd=resolve;});
    let resolved = false;
    const first = session.sendPrompt('first',{onRawRecord:row => {if(Reflect.get(row as object,'type')==='agent_end') lowEnd();}});
    void first.then(() => {resolved=true;});
    try {
        await ended; await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(resolved,false);
        await assert.rejects(session.sendPrompt('overlap'),/already active/);
        session.child.stdin!.write(JSON.stringify({type:'test_events',events:[{type:'agent_start'},end([assistant('queued continuation')]),settled]})+'\n');
        const completed=await first;
        assert.equal(completed.runtimeOutcome?.finalText,'queued continuation');
        assert.equal(completed.runtimeOutcome?.partialText,'Starting the read-only probe.PI_ACTIVITY_DONEqueued continuation');
        configure([end([assistant('second')]),settled]);
        const second = await session.sendPrompt('second');
        assert.deepEqual(second.runtimeOutcome,{status:'done',finalText:'second',partialText:'second'});
    } finally { session.kill(); await closed; delete process.env.PI_FINALITY_WARNING; }
});
test('pooled process termination rejects with bounded partial outcome', { timeout: 10000 }, async () => {
    configure([delta('interrupted partial')]);
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE,DEFAULT_PI_SETTINGS,{model:'fixture',cwd:root,root});
    const closed = once(session.child,'close');
    const done = session.sendPrompt('hold',{onEvent:event => {if(event.kind==='text') session.kill();}});
    await assert.rejects(done,error => {
        assert.deepEqual(piFailureOutcome(error),{status:'stopped',finalText:null,partialText:'interrupted partial'}); return true;
    });
    await closed;
});
test('a dropped oversized frame fails the pooled prompt at once instead of waiting for a lost terminal', { timeout: 15000 }, async () => {
    configure([delta('before drop'), delta('x'.repeat(MAX_PENDING_LINE_CHARS + 16))]);
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE,DEFAULT_PI_SETTINGS,{model:'fixture',cwd:root,root});
    const closed = once(session.child,'close');
    try {
        await assert.rejects(session.sendPrompt('fixture'),error => {
            assert.match(String(error),/frame dropped/);
            assert.deepEqual(piFailureOutcome(error),{status:'error',finalText:null,partialText:'before drop'}); return true;
        });
        assert.equal(session.alive,false,'a session that lost a frame is not reused');
    } finally {session.kill();await closed;}
});
test('a dropped oversized frame fails the direct prompt even when the child exits 0', { timeout: 15000 }, async () => {
    const { result } = await direct([delta('before drop'), delta('x'.repeat(MAX_PENDING_LINE_CHARS + 16)), end([assistant('ok')]), settled])
        .then(r => r, error => ({ result: { runtimeOutcome: piFailureOutcome(error) } }));
    assert.deepEqual(result.runtimeOutcome,{status:'error',finalText:null,partialText:'before drop'});
});
test('modern correlated abort waits for terminal and preserves stopped partial', { timeout: 10000 }, async () => {
    configure([delta('before abort')]);
    const session=spawnPersistentPiRpc(DEFAULT_PI_PROFILE,DEFAULT_PI_SETTINGS,{model:'fixture',cwd:root,root});
    const closed=once(session.child,'close');
    let aborting:Promise<void>|undefined;
    try {
        const result=await session.sendPrompt('hold',{onEvent:event => {if(event.kind==='text') aborting=session.abort();}});
        assert.ok(aborting);await aborting;
        assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:'before abort'});
    } finally {session.kill();await closed;}
});
test('correlated prompt rejection resolves direct error and rejects persistent with owned outcome', { timeout: 10000 }, async () => {
    const rows = [delta('accepted'),{type:'response',id:'$prompt',command:'prompt',success:false,error:'fixture rejection'}];
    assert.deepEqual((await direct(rows)).result.runtimeOutcome,{status:'error',finalText:null,partialText:'accepted'});
    configure(rows);
    const session = spawnPersistentPiRpc(DEFAULT_PI_PROFILE,DEFAULT_PI_SETTINGS,{model:'fixture',cwd:root,root});
    const closed = once(session.child,'close');
    try {
        await assert.rejects(session.sendPrompt('fixture'),error => {
            assert.match(String(error),/fixture rejection/);
            assert.deepEqual(piFailureOutcome(error),{status:'error',finalText:null,partialText:'accepted'}); return true;
        });
    } finally {session.kill();await closed;}
});

test('real direct adapter distinguishes protocol completion code from typed failure, empty and absent finals', { timeout: 15000 }, async () => {
    for (const [text, reason, status] of [
        [null, 'stop', 'done'], ['', 'stop', 'done'], [' \n\t ', 'stop', 'done'],
        ['failure', 'error', 'error'], ['partial', 'aborted', 'stopped'],
        ['length', 'length', 'error'], ['tool', 'toolUse', 'done'],
    ] as const) {
        const { result } = await direct([end([assistant(text, reason)]), settled]);
        assert.equal(result.code, 0, 'agent terminal completion is not an OS exit failure');
        assert.deepEqual(result.runtimeOutcome, { status, finalText: reason === 'stop' ? text : null, partialText: text ?? '' });
    }
});

test('real direct malformed and oversized final never returns a truncated successful answer', { timeout: 10000 }, async () => {
    for (const value of [null, [{ type: 'text', text: 'x'.repeat(FULLTEXT_MAX_CHARS + 1) }]]) {
        const { result } = await direct([end([{ role: 'assistant', stopReason: 'stop', content: value }]), settled]);
        assert.equal(result.code, 0);
        assert.equal(result.runtimeOutcome?.status, 'error'); assert.equal(result.runtimeOutcome?.finalText, null);
        assert.ok((result.runtimeOutcome?.partialText.length ?? Infinity) <= FULLTEXT_MAX_CHARS);
    }
});

test('legacy retry and unrecognized versions retain text compatibility but require typed final success', { timeout: 10000 }, async () => {
    for (const version of ['0.80.3', 'fake-pi 1.0.0', '0.80.4-beta']) {
        const rows = [{ ...end([assistant('retry', 'error')]), willRetry: true },
            { type: 'agent_start' }, end([assistant('legacy final')])];
        const { result } = await direct(rows, false, version);
        assert.deepEqual(result.runtimeOutcome, { status: 'done', finalText: 'legacy final', partialText: 'retrylegacy final' });
    }
    const untyped = await direct([delta('legacy text'), end([{ role: 'assistant', content: [{ type: 'text', text: 'legacy text' }] }])], false, 'fake-pi 1.0.0');
    assert.equal(untyped.result.text, 'legacy text');
    assert.deepEqual(untyped.result.runtimeOutcome, { status: 'error', finalText: null, partialText: 'legacy text' });
});

test('unsuccessful version stdout does not enable modern settled waiting', { timeout: 10000 }, async () => {
    const previous = process.env.PI_FINALITY_VERSION_EXIT;
    process.env.PI_FINALITY_VERSION_EXIT = '1';
    try {
        const { result } = await direct([end([final])], false, '0.80.4');
        assert.equal(result.runtimeOutcome?.finalText, 'PI_ACTIVITY_DONE');
    } finally {
        if (previous === undefined) delete process.env.PI_FINALITY_VERSION_EXIT; else process.env.PI_FINALITY_VERSION_EXIT = previous;
    }
});

test('orphan settled and empty invocation completion never resurrect an earlier final', () => {
    assert.deepEqual(accumulate([settled]).outcome, { status: 'done', finalText: null, partialText: '' });
    assert.deepEqual(accumulate([end([final]), { type: 'agent_start' }, end([]), settled]).outcome,
        { status: 'done', finalText: null, partialText: 'PI_ACTIVITY_DONE' });
});
