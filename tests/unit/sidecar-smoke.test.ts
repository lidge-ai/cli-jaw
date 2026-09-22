import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import ts from 'typescript';
import { resolveCanonicalDirectory, runSidecarSmoke } from '../../scripts/check-sidecar-smoke.mjs';
import { requestGracefulStop } from '../../scripts/sidecar-smoke-probe.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const cli=path.join(repo,'scripts/check-sidecar-smoke.mjs');
const policy=ts.transpileModule(fs.readFileSync(path.join(repo,'src/shared/isolated-qa.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
const worker=`import http from 'node:http';
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,version:'fixture'}));});
server.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
const manager=`import http from 'node:http';
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,pid:process.pid,port:Number(process.env.DASHBOARD_PORT),rangeFrom:Number(process.env.DASHBOARD_SCAN_FROM),rangeTo:Number(process.env.DASHBOARD_SCAN_FROM)}));});
server.listen(Number(process.env.DASHBOARD_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

test('sidecar graceful stop emits SIGTERM on Windows and self-signals on POSIX',()=>{
    const windowsCalls:Array<[string,...unknown[]]>=[];
    requestGracefulStop('win32',{
        pid:41001,
        emit:(...args:unknown[])=>{windowsCalls.push(['emit',...args]);return true;},
        kill:(...args:unknown[])=>{windowsCalls.push(['kill',...args]);return true;},
    });
    assert.deepEqual(windowsCalls,[['emit','SIGTERM']]);

    const posixCalls:Array<[string,...unknown[]]>=[];
    requestGracefulStop('darwin',{
        pid:41002,
        emit:(...args:unknown[])=>{posixCalls.push(['emit',...args]);return true;},
        kill:(...args:unknown[])=>{posixCalls.push(['kill',...args]);return true;},
    });
    assert.deepEqual(posixCalls,[['kill',41002,'SIGTERM']]);
});

test('canonical directories use native realpath so Windows 8.3 aliases are not passed to child policy checks',()=>{
    let ordinaryCalls=0,nativeCalls=0;
    const realpathSync=Object.assign(
        ()=>{ordinaryCalls++;return 'C:\\Users\\RUNNER~1\\Temp\\jaw';},
        {native:()=>{nativeCalls++;return 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\jaw';}},
    );
    const fileSystem={realpathSync,statSync:()=>({isDirectory:()=>true})};
    assert.equal(
        resolveCanonicalDirectory('C:\\Users\\RUNNER~1\\Temp\\jaw',fileSystem),
        'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\jaw',
    );
    assert.equal(nativeCalls,1);
    assert.equal(ordinaryCalls,0);
});

function fixture(t:TestContext,underRepo=false){
    const parent=underRepo?path.join(repo,'.tmp'):fs.realpathSync(os.tmpdir());
    if(underRepo)fs.mkdirSync(parent,{recursive:true});
    const root=fs.realpathSync(fs.mkdtempSync(path.join(parent,'sidecar-fixture-')));
    const results: Awaited<ReturnType<typeof runSidecarSmoke>>[]=[];
    const node=path.join(root,process.platform==='win32'?'node.exe':'node');
    // A real copy, never a mutable hard link to the host executable.
    fs.copyFileSync(process.execPath,node,fs.constants.COPYFILE_FICLONE);
    const put=(name:string,value:string)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
    put('package.json',JSON.stringify({name:'sidecar-fixture',version:'0.0.0',type:'module'}));
    put('dist/src/shared/isolated-qa.js',policy);
    put('dist/src/telegram/bot.js','export const imported = true;\n');
    put('dist/server.js',worker);put('dist/src/manager/server.js',manager);
    t.after(()=>{
        for(const result of results){
            assert.ok(result.probes.every(row=>row.closed&&row.groupAbsent!==false),'never erase an unclosed real fixture');
            fs.rmSync(result.runRoot,{recursive:true,force:true});
        }
        fs.rmSync(root,{recursive:true,force:true});
    });
    return {root,node,put,async run(options:Record<string,unknown>={}){
        const result=await runSidecarSmoke({serverRoot:root,timeoutMs:5000,shutdownMs:1000,...options});results.push(result);return result;
    }};
}

test('target Node executes all three exact imports/listeners and paired cleanup, without auth-prefix disclosure',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',"console.log('Auth: abcdef12... Bearer fixture-token'); export const ok=true;\n");
    const result=await f.run();
    assert.equal(result.ok,true,JSON.stringify(result.probes));assert.equal(result.code,0);
    assert.deepEqual(result.probes.map(row=>row.id),['telegram','worker','manager']);
    for(const row of result.probes){
        assert.equal(row.imported,true);assert.equal(row.closed,true);assert.equal(row.exitCode,0);assert.equal(row.signal,null);assert.equal(row.rootRemoved,true);
        assert.equal(row.command[0],path.join(result.executionRoot,process.platform==='win32'?'node.exe':'node'));
        assert.equal(row.executable,row.command[0]);
        assert.equal(row.node,process.version);assert.deepEqual(row.issues,[]);
        assert.ok(row.portsAbsent.every(Boolean));
        if(row.kind==='server'){assert.equal(row.listening,true);assert.equal(row.httpReady,true);assert.equal(row.stopAcknowledged,true);}
    }
    assert.equal(fs.existsSync(result.executionRoot),false);assert.equal(result.cleanup.ok,true);
    const recorded=fs.readFileSync(result.reportPath,'utf8');assert.doesNotMatch(recorded,/abcdef12|fixture-token/);
    assert.match(recorded,/REDACTED/);
    assert.ok(fs.existsSync(f.node),'original artifact must remain');
    const cleanup=JSON.parse(fs.readFileSync(result.reportPath+'.cleanup.json','utf8'));
    assert.equal(cleanup.reportPath,result.reportPath);assert.equal(cleanup.ok,true);assert.equal(cleanup.removed.length,4);
});

test('sync and promisified metadata use only captured target PATH, not a supplied shell or provider path',async t=>{
    const f=fixture(t);
    f.put('dist/src/telegram/bot.js',`import {execFileSync,spawnSync,execFile,exec} from 'node:child_process';
import {promisify} from 'node:util'; import fs from 'node:fs';
const query=process.platform==='win32'?'where.exe':'which';const args=process.platform==='win32'?['node']:['-a','node'];
const first=execFileSync(query,args,{encoding:'utf8',env:{PATH:'/unapproved'}}).trim().split(/\\r?\\n/)[0];
if(fs.realpathSync(first)!==fs.realpathSync(process.execPath))throw Error('borrowed host Node');
const sync=spawnSync(process.execPath,['--version'],{encoding:'utf8'});if(sync.status!==0||sync.stdout.trim()!==process.version)throw Error('metadata version');
const a=await promisify(execFile)(query,args,{encoding:'utf8'});if(typeof a.stdout!=='string')throw Error('execFile promise shape');
const b=await promisify(exec)('command -v node',{encoding:'utf8'});if(typeof b.stdout!=='string')throw Error('exec promise shape');
`);
    const result=await f.run();assert.equal(result.ok,true,JSON.stringify(result.probes));
    const ledger=result.probes[0].boundary;assert.ok(ledger.some(row=>row.kind==='metadata'));
    const starts=ledger.filter(row=>row.phase==='start'),closes=ledger.filter(row=>row.phase==='closed');
    assert.equal(starts.length,closes.length);
});

for(const [name,source] of [
    ['TypeError',"throw new TypeError('actual arbitrary exception');"],
    ['nonzero',"process.exit(7);"],
    ['signal',"process.kill(process.pid,'SIGTERM');"],
    ['kept-alive import',"setInterval(()=>{},1000);await new Promise(()=>{});"],
    ['lingering finite initializer',"setInterval(()=>{},1000);export const done=true;"],
] as const)test(`never certifies ${name} as a completed import`,async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',source);
    const result=await f.run({timeoutMs:name.includes('alive')||name.includes('lingering')?200:5000});
    assert.equal(result.ok,false);assert.equal(result.code,1);assert.equal(result.probes[0].ok,false);
    assert.ok(result.probes[0].issues.length>0);assert.equal(result.cleanup.ok,false);
    assert.ok(fs.existsSync(result.probes[0].root),'failed payload evidence remains');
});

for(const [name,source] of [
    ['Node eval',"import cp from 'node:child_process';try{cp.execFileSync(process.execPath,['-e','process.exit(0)']);}catch{}"],
    ['Windows command shim',"import cp from 'node:child_process';cp.spawnSync('cmd.exe',['/d','/s','/c','node','--version']);"],
    ['shell option',"import cp from 'node:child_process';cp.spawnSync('which',['node'],{shell:true});"],
    ['async shell',"import {exec} from 'node:child_process';await new Promise(resolve=>exec('echo unapproved',()=>resolve()));"],
    ['destructive security verb',"import cp from 'node:child_process';try{cp.execFileSync('security',['delete-keychain']);}catch{}"],
    ['credential shell suffix',"import cp from 'node:child_process';try{cp.execSync('gh auth token; echo forbidden');}catch{}"],
] as const)test(`caught forbidden ${name} cannot disappear from the smoke verdict`,async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',source);
    const result=await f.run();assert.equal(result.ok,false);assert.ok(result.probes[0].issues.includes('forbidden-process'));
    assert.ok(result.probes[0].boundary.some(row=>row.kind==='forbidden-process'));
});

test('owned bootstrap Git metadata stays unavailable without delegating Git',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',`import cp from 'node:child_process';import path from 'node:path';
const project=path.join(process.env.CLI_JAW_ISOLATED_QA_ROOT,'project');
for(const args of [['-C',project,'remote','get-url','origin'],['-C',project,'branch','--show-current']]){
  let code;try{cp.execFileSync('git',args,{encoding:'utf8'});}catch(error){code=error.code;}
  if(code!=='ENOENT')throw Error('Git discovery was executed or manufactured');
}
`);
    const result=await f.run();assert.equal(result.ok,true,JSON.stringify(result.probes));
    assert.deepEqual(result.probes[0].boundary.map(row=>[row.kind,row.phase]),[
        ['unavailable-discovery','start'],['unavailable-discovery','closed'],
        ['unavailable-discovery','start'],['unavailable-discovery','closed'],
    ]);
});

test('bootstrap Git exceptions never admit foreign roots, extra flags, mutations or lookalike executables',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',`import cp from 'node:child_process';import path from 'node:path';
const project=path.join(process.env.CLI_JAW_ISOLATED_QA_ROOT,'project');
const calls=[['git',['-C',process.env.HOME,'branch','--show-current']],
 ['git',['-C',project,'remote','get-url','other']],['git',['-C',project,'push']],
 ['git',['-C',project,'branch','--show-current','--extra']],
 ['git',['-c','alias.branch=!echo unexpected','-C',project,'branch','--show-current']],
 ['/unapproved/git',['-C',project,'branch','--show-current']]];
for(const [command,args] of calls)try{cp.execFileSync(command,args);}catch{}
`);
    const result=await f.run();assert.equal(result.ok,false);
    assert.ok(result.probes[0].issues.includes('forbidden-process'));
    const starts=result.probes[0].boundary.filter(row=>row.phase==='start');
    assert.equal(starts.length,6);assert.ok(starts.every(row=>row.kind==='forbidden-process'));
});

test('denied credential discovery is unavailable, never delegated or represented as auth',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',`import cp from 'node:child_process';
for(const [file,args] of [['security',['find-generic-password']],['gh',['auth','token']]]){
  const result=cp.spawnSync(file,args);if(!result.error||result.status===0)throw Error('credential false success');
}
try{cp.execSync('gh auth token');throw Error('credential delegated');}catch(e){if(e.message==='credential delegated')throw e;}
`);
    const result=await f.run();assert.equal(result.ok,true,JSON.stringify(result.probes));
    assert.ok(result.probes[0].boundary.some(row=>row.kind==='blocked-credential'));
});

for(const variant of ['nonce','pid','unknown','flood','oversized'] as const)test(`rejects ${variant} IPC independently of ordinary exit`,async t=>{
    const f=fixture(t);const base="{version:1,caseId:process.argv[3],nonce:process.argv[4],kind:'imported',pid:process.pid,node:process.version,executable:process.execPath}";
    const message=variant==='nonce'?base.replace('nonce:process.argv[4]',"nonce:'bad'")
        :variant==='pid'?base.replace('pid:process.pid','pid:process.pid+1')
        :variant==='unknown'?base.replace("kind:'imported'","kind:'unknown'")
        :variant==='oversized'?base.replace("kind:'imported'","kind:'error',error:'x'.repeat(40000)"):base;
    f.put('dist/src/telegram/bot.js',variant==='flood'?`for(let i=0;i<40;i++)process.send(${message});`:`process.send(${message});`);
    const result=await f.run(),diagnostics=JSON.stringify({error:result.error,probes:result.probes});
    assert.equal(result.ok,false,diagnostics);assert.ok(result.probes[0].issues.some(value=>/IPC|receipt/.test(value)),diagnostics);
    if(variant==='flood'){
        assert.ok(result.probes[0].issues.some(value=>value==='duplicate/invalid import receipt'||value==='IPC bound/shape'),diagnostics);
        assert.equal(result.probes[0].closed,true,diagnostics);
        assert.equal(result.probes[0].groupAbsent,process.platform==='win32'?null:true,diagnostics);
    }
    if(variant==='oversized')assert.ok(result.probes[0].issues.includes('IPC bound/shape'),diagnostics);
});

for(const packets of [32,33])test(`actual IPC handler rejects ${packets} synchronous receipts with exact count-bound behavior`,async t=>{
    const f=fixture(t),spawn=childProcess.spawn;
    // Keep the real import pending so its normal completion packet cannot
    // contaminate this controlled batch. Production still owns child cleanup.
    f.put('dist/src/telegram/bot.js','setInterval(()=>{},1000);await new Promise(()=>{});');
    let spawns=0,targets=0,delivered=0,listeners=0,closed=false;
    let target:ReturnType<typeof childProcess.spawn>|undefined;
    try{
        t.mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{
            const child=spawn(...args),[executable,argv]=args;
            spawns++;
            if(spawns===1&&Array.isArray(argv)&&argv.length===4
                &&argv[0]===path.join(repo,'scripts/sidecar-smoke-probe.mjs')&&argv[2]==='telegram'
                &&typeof argv[1]==='string'&&typeof argv[3]==='string'&&/^[a-f0-9]{48}$/.test(argv[3])
                &&executable===path.join(argv[1],process.platform==='win32'?'node.exe':'node')){
                targets++;target=child;
                child.once('close',()=>{closed=true;});
                const message={version:1,caseId:argv[2],nonce:argv[3],kind:'imported',
                    pid:child.pid,node:process.version,executable};
                queueMicrotask(()=>{
                    listeners=child.listenerCount('message');
                    if(listeners!==1||!child.pid)return;
                    // One batch prevents cleanup from interleaving between
                    // the duplicate receipt and the 33rd message.
                    for(let i=0;i<packets;i++){child.emit('message',message);delivered++;}
                });
            }
            return child;
        });
        syncBuiltinESMExports();
        const result=await f.run(),row=result.probes[0];
        const diagnostics=JSON.stringify({error:result.error,probes:result.probes,spawns,targets,delivered,listeners,closed});
        assert.equal(targets,1,diagnostics);assert.equal(listeners,1,diagnostics);assert.equal(delivered,packets,diagnostics);
        assert.equal(result.ok,false,diagnostics);assert.equal(result.code,1,diagnostics);
        assert.ok(row,diagnostics);assert.equal(row.id,'telegram',diagnostics);assert.equal(row.pid,target?.pid,diagnostics);
        assert.equal(row.imported,true,diagnostics);assert.equal(row.node,process.version,diagnostics);
        assert.equal(row.executable,row.command[0],diagnostics);
        assert.ok(row.issues.includes('duplicate/invalid import receipt'),diagnostics);
        assert.equal(row.issues.includes('IPC bound/shape'),packets===33,diagnostics);
        assert.equal(row.issues.includes('IPC identity'),false,diagnostics);
        assert.equal(closed,true,diagnostics);assert.equal(row.closed,true,diagnostics);
        assert.equal(row.groupAbsent,process.platform==='win32'?null:true,diagnostics);
        assert.ok(row.portsAbsent.every(Boolean),diagnostics);
    }finally{
        t.mock.restoreAll();syncBuiltinESMExports();
    }
});

test('outbound network, a non-loopback bind and wrong Manager health all fail before certification',async t=>{
    for(const variant of ['fetch','bind','health'])await t.test(variant,async child=>{
        const f=fixture(child);
        if(variant==='fetch')f.put('dist/src/telegram/bot.js',"try{await fetch('https://invalid.example/');}catch{};");
        if(variant==='bind')f.put('dist/server.js',worker.replace("'127.0.0.1'","'0.0.0.0'"));
        if(variant==='health')f.put('dist/src/manager/server.js',manager.replace('pid:process.pid','pid:process.pid+1'));
        const result=await f.run();assert.equal(result.ok,false);assert.ok(result.probes.some(row=>!row.ok));
    });
});

test('missing dynamic dependency cannot borrow the checkout package tree',async t=>{
    const f=fixture(t,true);assert.ok(fs.existsSync(path.join(repo,'node_modules/yaml/package.json')));
    f.put('dist/src/telegram/bot.js',"import 'yaml';export const ok=true;");
    const missing=await f.run();assert.equal(missing.ok,false);assert.equal(missing.probes[0].imported,false);
    f.put('node_modules/yaml/package.json','{"name":"yaml","type":"module","exports":"./index.js"}');
    f.put('node_modules/yaml/index.js','export const packaged = true;');
    const local=await f.run();assert.equal(local.ok,true,JSON.stringify(local.probes));
});

test('validated internal relative symlinks remain relocatable and execute from the copy',async t=>{
    const f=fixture(t);f.put('node_modules/tool/package.json','{"name":"tool","type":"module"}');
    f.put('node_modules/tool/bin.js','export const value=17;');
    fs.mkdirSync(path.join(f.root,'node_modules/.bin'));
    fs.symlinkSync('../tool/bin.js',path.join(f.root,'node_modules/.bin/tool'));
    f.put('dist/src/telegram/bot.js',"import {value} from '../../../node_modules/.bin/tool';if(value!==17)throw Error('wrong linked module');");
    const result=await f.run();assert.equal(result.ok,true,result.error??JSON.stringify(result.probes));
    assert.equal(fs.readlinkSync(path.join(f.root,'node_modules/.bin/tool')),'../tool/bin.js');
});

test('fresh report paths inside the original artifact, including aliased parents, reject without mutation',async t=>{
    const f=fixture(t),before=fs.readdirSync(f.root).sort();
    const aliasRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sidecar-report-alias-')));
    t.after(()=>fs.rmSync(aliasRoot,{recursive:true,force:true}));
    fs.symlinkSync(f.root,path.join(aliasRoot,'inside'),process.platform==='win32'?'junction':'dir');
    for(const reportPath of [path.join(f.root,'new-report.json'),path.join(aliasRoot,'inside/new-report.json')]){
        await assert.rejects(f.run({reportPath}),/report.*artifact/i);
        assert.deepEqual(fs.readdirSync(f.root).sort(),before);
    }
    t.mock.method(os,'tmpdir',()=>f.root);
    await assert.rejects(f.run(),/temp.*artifact/i);
    assert.deepEqual(fs.readdirSync(f.root).sort(),before);
});

test('preflight rejects missing binary/module, .env, escaping links and existing reports',async t=>{
    const f=fixture(t);const reportRoot=fs.mkdtempSync(path.join(os.tmpdir(),'sidecar-existing-report-'));
    t.after(()=>fs.rmSync(reportRoot,{recursive:true,force:true}));
    const report=path.join(reportRoot,'existing.json');fs.writeFileSync(report,'sentinel');
    await assert.rejects(f.run({reportPath:report}),/EEXIST/);assert.equal(fs.readFileSync(report,'utf8'),'sentinel');
    f.put('.env','PRIVATE_SENTINEL=never_loaded');await assert.rejects(f.run(),/\.env/);fs.rmSync(path.join(f.root,'.env'));
    const module=path.join(f.root,'dist/src/telegram/bot.js');fs.rmSync(module);await assert.rejects(f.run(),/ENOENT|missing/);f.put('dist/src/telegram/bot.js','');
    const link=path.join(f.root,'external-link');fs.symlinkSync(repo,link,process.platform==='win32'?'junction':'dir');
    const escaped=await f.run();assert.equal(escaped.ok,false);assert.match(escaped.error,/symlink/);fs.unlinkSync(link);
    fs.rmSync(f.node);await assert.rejects(f.run(),/ENOENT|missing/);
});

test('CLI absent/default skipped differs from explicit missing and rejects ambiguous arguments',async t=>{
    const cwd=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'sidecar-cli-'));
    let cleanupSafe=true;
    t.after(()=>{if(cleanupSafe)fs.rmSync(cwd,{recursive:true,force:true});});
    const report=path.join(cwd,'must-not-exist.json');
    const run=async(args:string[],extraEnv:Record<string,string>={})=>{
        cleanupSafe=false;
        const child=childProcess.spawn(process.execPath,[cli,...args],{
            cwd,env:{PATH:path.dirname(process.execPath),...extraEnv},stdio:['ignore','pipe','pipe'],
        });
        let retired=false,closed=false,output='',bytes=0,failure:string|undefined;
        let hardStop:ReturnType<typeof setTimeout>|undefined;
        const signal=(name:NodeJS.Signals)=>{
            if(retired||child.exitCode!==null||child.signalCode!==null)return;
            try{if(!child.kill(name))retired=true;}catch{retired=true;}
        };
        const stop=(reason:string)=>{
            failure??=reason;signal('SIGTERM');hardStop??=setTimeout(()=>signal('SIGKILL'),1000);
        };
        child.once('error',error=>{retired=true;failure??=error.message;});
        child.once('exit',()=>{retired=true;});
        const receive=(chunk:string)=>{
            bytes+=Buffer.byteLength(chunk);if(bytes>256*1024){stop('output overflow');return;}output+=chunk;
        };
        child.stdout.setEncoding('utf8').on('data',receive);child.stderr.setEncoding('utf8').on('data',receive);
        const timer=setTimeout(()=>stop('CLI timeout'),5000);
        let boundary:ReturnType<typeof setTimeout>;
        const result=await new Promise<{status:number|null;signal:NodeJS.Signals|null}>(resolve=>{
            boundary=setTimeout(()=>{
                failure??='child close unproven';child.stdout.destroy();child.stderr.destroy();child.unref();
                resolve({status:null,signal:null});
            },7500);
            child.once('close',(status,sig)=>{retired=true;closed=true;resolve({status,signal:sig});});
        });
        clearTimeout(timer);clearTimeout(boundary!);clearTimeout(hardStop);
        assert.equal(closed,true,`retain unclosed CLI fixture: ${cwd}`);
        assert.equal(failure,undefined,`${failure}: fixture retained at ${cwd}`);
        assert.equal(result.signal,null);assert.notEqual(result.status,null);
        cleanupSafe=true;
        assert.equal(fs.existsSync(report),false,'no premature primary report');
        assert.equal(fs.existsSync(report+'.cleanup.json'),false,'no premature cleanup report');
        assert.doesNotMatch(output,/Sidecar smoke PASS/);
        return {...result,output};
    };
    assert.equal((await run([])).status,3);
    assert.equal((await run(['--server-root',path.join(cwd,'missing')])).status,1);
    const optionalEnvironments:Record<string,string>[]=[{},{CI:'1'},{JAW_GATE_REQUIRE_SIDECAR:'0'}];
    for(const env of optionalEnvironments){
        const result=await run(['--report',report],env);
        assert.equal(result.status,3,result.output);assert.match(result.output,/SKIPPED.*not verified.*nothing imported/);
    }
    for(const [args,env] of [
        [['--report',report],{JAW_GATE_REQUIRE_SIDECAR:'1'}],
        [['--server-root',path.join(cwd,'missing'),'--report',report],{JAW_GATE_REQUIRE_SIDECAR:'0'}],
    ] as const){
        const result=await run([...args],env);
        assert.equal(result.status,1,result.output);assert.match(result.output,/required a real smoke test/);
        assert.doesNotMatch(result.output,/SKIPPED/);
    }
    for(const args of [
        ['--server-root'],['--unknown'],['--report'],['--server-root','a','--server-root','b'],
        ['--report',report,'--server-root'],['--report',report,'--unknown'],
        ['--report',report,'--report',report+'.other'],['--server-root','--report',report],
        ['--server-root','','--report',report],['--report',''],['--help','--report',report],
    ]){
        const result=await run(args);
        assert.equal(result.status,2,`${JSON.stringify(args)}: ${result.output}`);
        assert.match(result.output,/Usage: check-sidecar-smoke/);
        assert.doesNotMatch(result.output,/SKIPPED|required a real smoke test/);
        assert.equal(fs.existsSync(report+'.other'),false);
    }
    for(const flag of ['--help','-h']){
        const result=await run([flag]);assert.equal(result.status,0,result.output);
        assert.match(result.output,/^Usage: check-sidecar-smoke/);assert.doesNotMatch(result.output,/SKIPPED|Sidecar smoke/);
    }
    const nonDirectory=path.join(cwd,'file');fs.writeFileSync(nonDirectory,'sentinel');
    const incomplete=path.join(cwd,'incomplete');fs.mkdirSync(incomplete);
    for(const root of [nonDirectory,incomplete]){
        const result=await run(['--server-root',root,'--report',report]);
        assert.equal(result.status,1,result.output);assert.match(result.output,/Sidecar smoke failed:/);
        assert.doesNotMatch(result.output,/Usage:|SKIPPED/);
    }
    // Otherwise valid inputs: these failures must reach report validation, not missing-module checks.
    // This artifact shares the CLI's cleanup fence; never delete it after an unproven CLI close.
    const validRoot=path.join(cwd,'valid-artifact');
    const put=(name:string,value:string)=>{
        const file=path.join(validRoot,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);
    };
    put('package.json','{"name":"cli-report-fixture","version":"0.0.0","type":"module"}');
    put('dist/src/shared/isolated-qa.js',policy);put('dist/src/telegram/bot.js','export const imported=true;');
    put('dist/server.js',worker);put('dist/src/manager/server.js',manager);
    fs.copyFileSync(process.execPath,path.join(validRoot,process.platform==='win32'?'node.exe':'node'),fs.constants.COPYFILE_FICLONE);
    for(const destination of [path.join(cwd,'absent-parent','report.json'),path.join(validRoot,'report.json')]){
        const result=await run(['--server-root',validRoot,'--report',destination]);
        assert.equal(result.status,1,result.output);assert.doesNotMatch(result.output,/Usage:|SKIPPED/);
        assert.match(result.output,destination.startsWith(validRoot)?/Report destination must be outside/:/ENOENT/);
        assert.equal(fs.existsSync(destination),false);
    }
    const existing=path.join(cwd,'existing.json');fs.writeFileSync(existing,'existing report sentinel');
    const result=await run(['--server-root',validRoot,'--report',existing]);
    assert.equal(result.status,1,result.output);assert.match(result.output,/EEXIST/);
    assert.equal(fs.readFileSync(existing,'utf8'),'existing report sentinel');
    assert.equal(fs.existsSync(existing+'.cleanup.json'),false);
});

test('stdout overflow is bounded and never certified from a later clean exit',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',"process.stdout.write('x'.repeat(5*1024*1024));\n");
    const result=await f.run();assert.equal(result.ok,false);
    assert.ok(result.probes[0].issues.includes('output overflow'));
    assert.ok(Buffer.byteLength(result.probes[0].output)<=4*1024*1024);
});

test('ready then crash and uncooperative stop cannot be converted to successful cleanup',async t=>{
    for(const mode of ['crash','ignore-stop'])await t.test(mode,async child=>{
        const f=fixture(child);
        if(mode==='crash')f.put('dist/server.js',worker.replace("res.end(JSON.stringify({ok:true,version:'fixture'}));","res.end(JSON.stringify({ok:true,version:'fixture'}));setImmediate(()=>process.exit(9));"));
        else f.put('dist/server.js',worker.replace("()=>server.close(()=>process.exit(0))","()=>{}"));
        const result=await f.run({shutdownMs:mode==='ignore-stop'?50:1000});
        assert.equal(result.ok,false);const row=result.probes.find(value=>value.id==='worker')!;
        assert.equal(row.imported,true);assert.equal(row.listening,true);assert.equal(row.ok,false);
        if(mode==='crash')assert.equal(row.exitCode,9);
        else assert.ok(row.issues.includes('stop timeout'));
    });
});

test('caught boundary-write failure stays fatal rather than disappearing with an empty ledger',async t=>{
    const f=fixture(t);f.put('dist/src/telegram/bot.js',`import fs from 'node:fs';import cp from 'node:child_process';
fs.appendFileSync=()=>{throw Object.assign(Error('fixture full'),{code:'ENOSPC'});};
try{cp.execFileSync(process.execPath,['--version']);}catch{}
`);
    const result=await f.run();assert.equal(result.ok,false);assert.equal(result.probes[0].ok,false);
    assert.ok(result.probes[0].exitCode!==0||result.probes[0].issues.length>0);
});

test('primary evidence-write failure retains all payload roots after real child closure',async t=>{
    const f=fixture(t),roots:string[]=[],children:Array<{closed:boolean}>=[];
    const create=fs.mkdtempSync,write=fs.writeFileSync,spawn=childProcess.spawn;
    let injected=false;
    t.mock.method(fs,'mkdtempSync',(...args:Parameters<typeof fs.mkdtempSync>)=>{
        const root=create(...args);if(path.basename(String(args[0])).startsWith('jaw-sidecar-smoke-'))roots.push(String(root));return root;
    });
    t.mock.method(childProcess,'spawn',(...args:Parameters<typeof childProcess.spawn>)=>{
        const child=spawn(...args),observation={closed:false};children.push(observation);child.once('close',()=>{observation.closed=true;});return child;
    });
    t.mock.method(fs,'writeFileSync',(...args:Parameters<typeof fs.writeFileSync>)=>{
        if(typeof args[0]==='number'){injected=true;throw Object.assign(Error('fixture report ENOSPC'),{code:'ENOSPC'});}
        return write(...args);
    });
    syncBuiltinESMExports();
    try{
        await assert.rejects(f.run(),/ENOSPC/);assert.equal(injected,true);assert.equal(roots.length,1);
        assert.equal(children.length,3);assert.ok(children.every(child=>child.closed));
        assert.ok(fs.existsSync(path.join(roots[0]!,'artifact')),'artifact retained before durable evidence');
        for(const id of ['telegram-','worker-','manager-'])assert.ok(fs.readdirSync(roots[0]!).some(name=>name.startsWith(id)));
    }finally{
        t.mock.restoreAll();syncBuiltinESMExports();
        if(children.every(child=>child.closed))for(const root of roots)fs.rmSync(root,{recursive:true,force:true});
    }
});
