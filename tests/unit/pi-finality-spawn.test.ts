import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiRpcSession } from '../../src/agent/pi-runtime.ts';

const root = mkdtempSync(join(tmpdir(),'pi-spawn-finality-'));
const binary = join(root,'pi.mjs');
writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const note = type => {if(process.env.PI_SPAWN_VERSION_LEDGER) fs.appendFileSync(process.env.PI_SPAWN_VERSION_LEDGER, type+'\\n');};
if(process.argv.includes('--version')) {
 if(process.env.PI_SPAWN_HOLD_VERSION==='1') {
  process.on('SIGTERM',()=>note('version-stop'));
  note('version-start');
  const deadline=Date.now()+4000;
  while(!fs.existsSync(process.env.PI_SPAWN_VERSION_RELEASE)) {
   if(Date.now()>deadline){note('version-expired');process.exit(97);}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 note('version-finish');console.log('0.83.0');process.exit(0);
}
if(process.env.PI_SPAWN_IGNORE_RPC_TERM==='1') {
 process.on('SIGTERM',()=>note('rpc-term-ignored'));
 setInterval(()=>{},1000); // Also survive EOF: Stop must reach the paired owner's escalation.
 setTimeout(()=>{note('rpc-expired');process.exit(97);},8000);
}
note('rpc-ready');
const send = row => console.log(JSON.stringify(row));
for await(const line of readline.createInterface({input:process.stdin})) {
 const r = JSON.parse(line);
 if(r.type==='get_state') send({id:r.id,type:'response',command:r.type,success:true,data:{sessionId:'private-session'}});
 if(r.type==='prompt') {
  note('prompt');
  send({type:'agent_start'});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PROVISIONAL /goal done'}});
  if(process.env.PI_SPAWN_HOLD==='1') continue;
  send({type:'agent_end',willRetry:false,messages:[{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'PROVISIONAL /goal done'}]},
   {role:'assistant',stopReason:'stop',content:[{type:'text',text:'FINAL ONLY'}]}]});
  send({type:'agent_settled'});
 }
}
`);
chmodSync(binary,0o755);
const previousBin = process.env.PI_CODING_AGENT_BIN;
process.env.PI_CODING_AGENT_BIN = binary;
const config = await import('../../src/core/config.ts');
test.mock.module('../../src/core/config.js',{namedExports:{...config,detectCli:() => ({available:true,path:null})}});
const pi = await import('../../src/agent/pi-runtime.ts');
const sessions: PiRpcSession[] = [];
const physicalChildren = new Map<ChildProcess, { closed: boolean; done: Promise<void> }>();
let cleanupSafe = true;
function trackChild(child: ChildProcess): void {
    if(physicalChildren.has(child)) return;
    const state={closed:false,done:Promise.resolve()};
    state.done=new Promise(resolve=>child.once('close',()=>{state.closed=true;resolve();}));
    physicalChildren.set(child,state);
}
async function bounded<T>(promise:Promise<T>,label:string):Promise<T>{
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`fixture ${label} deadline`)),7000);})]);}
    finally{clearTimeout(timer!);}
}
async function until(predicate:()=>boolean,label:string):Promise<void>{
    const deadline=Date.now()+5000;
    while(!predicate()){
        if(Date.now()>=deadline)throw Error(`fixture ${label} deadline`);
        await new Promise(resolve=>setTimeout(resolve,10));
    }
}
const directDirectories: string[] = [];
let onText: (() => void) | undefined;
test.mock.module('../../src/agent/pi-runtime.js',{namedExports:{...pi,
    openPiRpc:(...args: Parameters<typeof pi.openPiRpc>) => {
        directDirectories.push(args[2].cwd); const opened=pi.openPiRpc(...args);trackChild(opened.child);return opened;
    },
    spawnPiRpc:(...args: Parameters<typeof pi.spawnPiRpc>) => {
        directDirectories.push(args[2].cwd); const execution=pi.spawnPiRpc(...args);trackChild(execution.child);return execution;
    },
    spawnPersistentPiRpc:(...args: Parameters<typeof pi.spawnPersistentPiRpc>) => {
        const session = pi.spawnPersistentPiRpc(...args);
        const send = session.sendPrompt.bind(session);
        session.sendPrompt = (message,opts) => send(message,{...opts,onEvent:event => {
            opts?.onEvent?.(event); if(event.kind==='text') onText?.();
        }});
        sessions.push(session);trackChild(session.child);return session;
    },
}});
const trace = await import('../../src/trace/store.ts');
let failRawTrace = false, failActivityJournal = false, rawFailures = 0, journalFailures = 0;
test.mock.module('../../src/trace/store.js',{namedExports:{...trace,
    appendTraceEvent:(...args: Parameters<typeof trace.appendTraceEvent>) => {
        if(failRawTrace && args[0].eventType?.startsWith('pi_rpc:')) {
            rawFailures++; throw new Error('fixture raw trace failed');
        }
        return trace.appendTraceEvent(...args);
    },
}});
const journal = await import('../../src/trace/activity-journal.ts');
test.mock.module('../../src/trace/activity-journal.js',{namedExports:{...journal,
    appendActivityBody:(...args: Parameters<typeof journal.appendActivityBody>) => {
        if(failActivityJournal) { journalFailures++; throw new Error('fixture activity journal failed'); }
        return journal.appendActivityBody(...args);
    },
}});
const { createChatSession, setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const {spawnAgent,killActiveAgent,killAgentById,waitForExitSettled,activeMainProcesses} = await import('../../src/agent/spawn.ts');
const {db,getMaxMessageId,getSteerSalvageAfter} = await import('../../src/core/db.ts');
const {subscribe} = await import('../../src/core/event-bus.ts');
const {clearGoalTimers} = await import('../../src/agent/lifecycle-handler.ts');
const {poolStats} = await import('../../src/agent/runtime-pool.ts');
let serial = 0;
test.beforeEach(context => {
    failRawTrace=false;failActivityJournal=false;rawFailures=0;journalFailures=0;directDirectories.length=0;onText=undefined;delete process.env.PI_SPAWN_HOLD;
    delete process.env.PI_SPAWN_HOLD_VERSION;delete process.env.PI_SPAWN_VERSION_LEDGER;delete process.env.PI_SPAWN_VERSION_RELEASE;
    delete process.env.PI_SPAWN_IGNORE_RPC_TERM;
    config.settings.workingDir = root;mkdirSync(join(root,'prompts'),{recursive:true});
    mkdirSync(join(config.JAW_HOME,'prompts'),{recursive:true});
    config.settings.fallbackOrder=[];config.settings.activeOverrides={};
    config.settings.pi=pi.normalizePiSettings(pi.DEFAULT_PI_SETTINGS);
    config.settings.perCli={...config.settings.perCli,pi:{model:'fixture',effort:'high',provider:'progrok'}};
    config.settings.memory={...config.settings.memory,enabled:false};
    config.settings.multiSession={enabled:true,maxConcurrent:4,midRunPolicy:'steer',channels:{telegram:true,discord:true,slack:true}};
    context.mock.method(globalThis,'fetch',async () => {throw new Error('unexpected network');});
    context.mock.method(console,'log',() => {});context.mock.method(console,'warn',() => {});context.mock.method(console,'error',() => {});
});
test.afterEach(async () => {
    onText=undefined;clearGoalTimers();
    try {
        for(const session of sessions.splice(0)) {session.kill();await bounded(Promise.resolve(session.close()),'session cleanup');}
        for(const [child,state] of physicalChildren) {
            if(!state.closed&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
            await bounded(state.done,'physical close');
        }
    } catch(error){cleanupSafe=false;throw error;}
    finally{physicalChildren.clear();}
    assert.equal(poolStats().busy,0);
});
test.after(() => {
    if(previousBin===undefined) delete process.env.PI_CODING_AGENT_BIN;else process.env.PI_CODING_AGENT_BIN=previousBin;
    delete process.env.PI_SPAWN_HOLD;delete process.env.PI_SPAWN_HOLD_VERSION;
    delete process.env.PI_SPAWN_VERSION_LEDGER;delete process.env.PI_SPAWN_VERSION_RELEASE;
    delete process.env.PI_SPAWN_IGNORE_RPC_TERM;
    if(cleanupSafe)rmSync(root,{recursive:true,force:true});
});
function options() {
    const id=++serial;
    const chat = createChatSession('Pi typed finality fixture'); setActiveChatSession('default');
    return {cli:'pi',model:'fixture',effort:'high',scopeKey:'pi-final-scope-'+id,chatSessionId:chat.id,
        requestId:'pi-final-request-'+id,origin:'web',sysPrompt:'',_skipInsert:true,_skipHistory:true,_skipResume:true,
        _skipSessionPersist:true,_isSmokeContinuation:true};
}
test('actual pooled Pi-to-lifecycle final uses only typed final and canonical jaw identity',async () => {
    const opts=options();const events: Record<string,unknown>[]=[];
    const unsub=subscribe(event => {if(event.event==='agent_runtime') events.push(event.data as Record<string,unknown>);});
    try {
        const result=await spawnAgent('fixture',opts).promise;
        assert.equal(result.text,'FINAL ONLY');
        assert.deepEqual(result.runtimeOutcome,{status:'done',finalText:'FINAL ONLY',partialText:'PROVISIONAL /goal doneFINAL ONLY'});
        const rows=db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant');
        assert.deepEqual(rows,[{content:'FINAL ONLY'}]);
        const ends=events.filter(event => event.kind==='turn-end');
        assert.equal(ends.length,1);assert.equal(ends[0]?.finalText,'FINAL ONLY');
        assert.ok(events.every(event => event.sessionId===opts.chatSessionId && event.scope===opts.scopeKey));
        assert.doesNotMatch(JSON.stringify(events),/private-session/);
        const traceId = String(ends[0]?.runId);
        assert.equal(trace.getTraceRun(traceId)?.session_id, opts.chatSessionId);
        assert.ok(journal.readActivityPage({runId:traceId,sessionId:opts.chatSessionId,after:0,limit:40})?.events.length);
    } finally {unsub();}
});
test('throwing exit observer cannot bypass lifecycle cleanup or final MESSAGE',async () => {
    const opts=options();
    const result=await spawnAgent('fixture',{...opts,lifecycle:{onExit:() => {throw new Error('fixture observer');}}}).promise;
    assert.equal(result.text,'FINAL ONLY');assert.equal(result.code,0);
    assert.equal(result.runtimeOutcome?.status,'done');
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
});
test('kill-steered Pi rejection stores interrupted MESSAGE before the real exit barrier despite raw trace failure',async () => {
    process.env.PI_SPAWN_HOLD='1';failRawTrace=true;
    const opts=options();const watermark=getMaxMessageId(opts.chatSessionId);
    let barrier:Promise<void>|undefined;let observed:string|null|undefined;
    onText=() => {
        onText=undefined;
        assert.equal(killActiveAgent(opts.scopeKey,'steer'),true);
        barrier=waitForExitSettled(opts.scopeKey).then(() => {observed=getSteerSalvageAfter(opts.chatSessionId,watermark);});
    };
    const result=await spawnAgent('hold',opts).promise;
    assert.ok(barrier,'real text callback armed kill-steer and exit barrier');await barrier;
    assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:'PROVISIONAL /goal done'});
    assert.equal(observed,'⏹️ [interrupted]\n\nPROVISIONAL /goal done');
    assert.equal(result.text,'');assert.notEqual(result.code,0);
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.ok(rawFailures > 0, 'raw failure injection must actually fire');
    assert.equal(journalFailures, 0);
});

test('user stop preserves partial outcome without inventing a final response',async () => {
    process.env.PI_SPAWN_HOLD='1';
    const opts=options();
    onText=() => {onText=undefined;assert.equal(killActiveAgent(opts.scopeKey,'user'),true);};
    const result=await spawnAgent('hold',opts).promise;
    assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:'PROVISIONAL /goal done'});
    assert.equal(result.text,'');assert.notEqual(result.code,0);
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[]);
});

for (const stop of [false, true]) test(`activity journal append failure cannot replace ${stop ? 'steer salvage' : 'the final MESSAGE'} or strand settlement`, {timeout:10_000}, async () => {
    failActivityJournal = true;
    if(stop) process.env.PI_SPAWN_HOLD='1';
    const opts=options(); const watermark=getMaxMessageId(opts.chatSessionId);
    let barrier:Promise<void>|undefined, observed:string|null|undefined;
    if(stop) onText=() => {
        onText=undefined;
        assert.equal(killActiveAgent(opts.scopeKey,'steer'),true);
        barrier=waitForExitSettled(opts.scopeKey).then(() => {observed=getSteerSalvageAfter(opts.chatSessionId,watermark);});
    };
    const result=await spawnAgent(stop?'hold':'fixture',opts).promise;
    assert.ok(journalFailures>0,'canonical journal injection must fire independently');
    assert.equal(rawFailures,0);
    const traceId=result.traceRunId;
    assert.ok(traceId);
    assert.ok(trace.listTraceEvents(traceId,0,200).events.some(row=>row.source==='cli_raw'),'raw storage still succeeds');
    if(stop) {
        assert.ok(barrier);await barrier;
        assert.equal(observed,'⏹️ [interrupted]\n\nPROVISIONAL /goal done');
        assert.equal(result.runtimeOutcome?.status,'stopped');assert.equal(result.runtimeOutcome?.finalText,null);
    } else {
        assert.equal(result.text,'FINAL ONLY');assert.equal(result.runtimeOutcome?.status,'done');
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
    }
    assert.equal(activeMainProcesses.has(opts.scopeKey),false);
});

test('raw trace append failure reports degraded Activity while preserving the exact final MESSAGE', {timeout:10_000}, async () => {
    failRawTrace=true;
    const opts=options();const result=await spawnAgent('fixture',opts).promise;
    assert.equal(result.text,'FINAL ONLY');assert.ok(rawFailures>0);assert.equal(journalFailures,0);
    assert.ok(result.traceRunId);
    const page=journal.readActivityPage({runId:result.traceRunId,sessionId:opts.chatSessionId,after:0,limit:40});
    assert.ok(page?.events.some(row=>row.kind==='turn-start'), JSON.stringify(page));
    assert.equal(page.incomplete, true);
    assert.equal(page.loss, 'storage_error', 'raw failure deliberately reports persistence degradation through the existing projection');
    assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[{content:'FINAL ONLY'}]);
});

test('throwing activity hook cannot corrupt accepted partial or final selection', {timeout:10_000}, async () => {
    const opts=options();let calls=0;
    const result=await spawnAgent('fixture',{...opts,lifecycle:{onActivity:()=>{calls++;throw Error('observer fixture');}}}).promise;
    assert.ok(calls>0);assert.equal(result.text,'FINAL ONLY');
    assert.equal(result.runtimeOutcome?.partialText,'PROVISIONAL /goal doneFINAL ONLY');
});

test('real employee direct Pi uses typed final and cleans its owned temporary directory', {timeout:10_000}, async () => {
    const opts=options();
    const run=spawnAgent('fixture',{...opts,agentId:'pi-typed-worker',sysPrompt:'fixture worker instructions'});
    assert.ok(run.child);
    const closed=once(run.child,'close');
    const result=await run.promise;await closed;
    assert.equal(result.text,'FINAL ONLY');assert.equal(result.runtimeOutcome?.status,'done');
    assert.equal(result.runtimeOutcome?.finalText,'FINAL ONLY');
    assert.equal(result.runtimeOutcome?.partialText,'PROVISIONAL /goal doneFINAL ONLY');
    assert.ok(result.traceRunId);
    const traceRow=trace.getTraceRun(result.traceRunId)!;
    assert.equal(traceRow.audience,'internal');
    assert.equal(journal.readActivityPage({runId:result.traceRunId,sessionId:opts.chatSessionId,after:0,limit:40}),null);
    assert.equal(directDirectories.length,1);
    assert.notEqual(directDirectories[0],root);
    assert.equal(existsSync(directDirectories[0]!),false);
});

for(const {employee,ignoreTerm} of [{employee:false,ignoreTerm:false},{employee:true,ignoreTerm:false},{employee:true,ignoreTerm:true}])
test(`real ${employee?'employee':'main'} Pi Stop waits for held version close without dispatch${ignoreTerm?' through worker API with TERM-ignoring RPC':''}`,{timeout:15_000},async t=>{
    const ledger=join(root,`version-${++serial}.jsonl`),release=join(root,`release-${serial}`);
    process.env.PI_SPAWN_HOLD_VERSION='1';process.env.PI_SPAWN_VERSION_LEDGER=ledger;process.env.PI_SPAWN_VERSION_RELEASE=release;
    if(ignoreTerm)process.env.PI_SPAWN_IGNORE_RPC_TERM='1';
    const originalSpawn=childProcess.spawn;const companions:ChildProcess[]=[];
    const signals:Array<{child:ChildProcess;signal:NodeJS.Signals|number|undefined;retired:boolean}>=[];
    const retainedSignals=new Map<ChildProcess,(signal:NodeJS.Signals)=>boolean>();
    const scheduled:number[]=[];const setTimer=globalThis.setTimeout;
    t.mock.method(globalThis,'setTimeout',(...args:Parameters<typeof setTimeout>)=>{
        scheduled.push(Number(args[1]));return Reflect.apply(setTimer,globalThis,args) as ReturnType<typeof setTimeout>;
    });
    t.mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{
        const child=Reflect.apply(originalSpawn,childProcess,args) as ChildProcess;
        trackChild(child);
        let retired=false;const retire=()=>{retired=true;};
        child.once('exit',retire);child.once('error',retire);child.once('close',retire);
        const originalKill=child.kill.bind(child);
        const send=(signal:NodeJS.Signals|number='SIGTERM')=>{
            const revoked=retired||child.exitCode!==null||child.signalCode!==null;
            signals.push({child,signal,retired:revoked});
            return revoked?false:originalKill(signal);
        };
        retainedSignals.set(child,send);
        // Production must capture this retained method before installing its public kill port.
        t.mock.method(child,'kill',send);
        if(Array.isArray(args[1])&&args[1].includes('--version'))companions.push(child);
        return child;
    });
    syncBuiltinESMExports();
    const rows=()=>existsSync(ledger)?readFileSync(ledger,'utf8').trim().split('\n'):[];
    const opts=options();
    const run=spawnAgent('held pre-prompt version',{...opts,...(employee?{agentId:'pi-version-worker',sysPrompt:'worker instructions'}:{})});
    let completed=false;void run.promise.then(()=>{completed=true;},()=>{completed=true;});
    try {
        assert.equal(Boolean(run.child),employee,'worker retains its actual synchronous RPC handle');
        await until(()=>rows().includes('version-start')&&rows().includes('rpc-ready')
            &&(employee||Boolean(activeMainProcesses.get(opts.scopeKey)?.cancelTurn)),'held version and owner');
        assert.equal(rows().includes('version-expired'),false);
        assert.equal(rows().includes('prompt'),false,'no prompt before capability close');
        assert.equal(companions.length,1);assert.equal(physicalChildren.get(companions[0]!)?.closed,false);
        const clocksBefore=scheduled.filter(delay=>delay===2000).length;
        const stoppedAt=performance.now();
        if(employee){
            assert.ok(run.child);assert.equal(run.child.exitCode,null);assert.equal(run.child.signalCode,null);
            if(ignoreTerm)assert.equal(killAgentById('pi-version-worker'),true,'actual worker API must consume the Pi cancellation port');
            else run.child.kill('SIGTERM');
        }
        else assert.equal(killActiveAgent(opts.scopeKey,'user'),true);
        if(ignoreTerm){
            assert.equal(scheduled.filter(delay=>delay===2000).length-clocksBefore,1,'Stop immediately starts one shared cleanup clock');
            assert.ok(signals.some(row=>row.child===run.child&&row.signal==='SIGTERM'));
            assert.ok(signals.some(row=>row.child===companions[0]&&row.signal==='SIGTERM'),'version receives Stop without waiting for RPC exit');
            await until(()=>rows().includes('rpc-term-ignored'),'RPC ignored real TERM');
        }
        await until(()=>rows().includes('version-stop'),'companion cancellation on RPC termination');
        assert.equal(completed,false,'logical completion must wait for bounded companion cleanup');
        if(employee)assert.equal(existsSync(directDirectories[0]!),true,'worker cwd retained before physical close');
        if(!ignoreTerm)writeFileSync(release,'release');
        const result=await bounded(run.promise,'Stop settlement');
        for(const companion of companions)await bounded(physicalChildren.get(companion)!.done,'version close');
        if(ignoreTerm){
            assert.ok(performance.now()-stoppedAt<3000,'paired cleanup must not wait for the 15s version deadline or legacy worker escalation');
            assert.equal(scheduled.filter(delay=>delay===2000).length-clocksBefore,1,'events do not restart the cleanup budget');
            for(const child of [run.child!,companions[0]!]){
                assert.ok(signals.some(row=>row.child===child&&row.signal==='SIGKILL'),'both TERM-ignoring paired children escalate');
                assert.equal(physicalChildren.get(child)?.closed,true);
            }
            assert.equal(rows().includes('version-expired'),false);assert.equal(rows().includes('rpc-expired'),false);
        }
        assert.ok(signals.every(row=>!row.retired),'no retained handle is signalled after exit/error/close');
        assert.equal(rows().includes('prompt'),false);
        assert.deepEqual(result.runtimeOutcome,{status:'stopped',finalText:null,partialText:''});
        assert.equal(result.text,'');assert.notEqual(result.code,0);
        assert.deepEqual(db.prepare('SELECT content FROM messages WHERE session_id=? AND role=?').all(opts.chatSessionId,'assistant'),[]);
        if(employee)assert.equal(existsSync(directDirectories[0]!),false,'certified owned worker cwd cleaned');
        else assert.equal(activeMainProcesses.has(opts.scopeKey),false);
    } finally {
        writeFileSync(release,'release');
        try {
            for(const [child,send] of retainedSignals)if(child.exitCode===null&&child.signalCode===null)send('SIGKILL');
            if(!employee&&activeMainProcesses.has(opts.scopeKey))killActiveAgent(opts.scopeKey,'user');
            for(const session of sessions){session.kill();await bounded(Promise.resolve(session.close()),'fixture session close');}
            await bounded(run.promise,'fixture final settlement');
            for(const state of physicalChildren.values())await bounded(state.done,'fixture physical close');
        } finally {t.mock.restoreAll();syncBuiltinESMExports();}
    }
});
