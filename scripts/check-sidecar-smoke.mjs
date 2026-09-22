#!/usr/bin/env node
/** Actual target-Node import/startup smoke; skipped, timed out and failed are distinct. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SMOKE_CASES } from './sidecar-smoke-probe.mjs';

const childEntry=fileURLToPath(new URL('./sidecar-smoke-probe.mjs',import.meta.url));
const MAX_OUTPUT=4*1024*1024;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function inside(root,file){const rel=path.relative(root,file);return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
export function resolveCanonicalDirectory(value,fileSystem=fs){
    const root=fileSystem.realpathSync.native(value);
    if(!fileSystem.statSync(root).isDirectory())throw Error('Server root is not a directory');
    return root;
}
function safeDirectory(value){return resolveCanonicalDirectory(value);}
function redact(value){return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/(\bAuth:\s*)\S+/g,'$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi,'$1[REDACTED]').replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{8,}/g,'[REDACTED]');}

async function treeIdentity(root){
    const digest=createHash('sha256');let files=0,bytes=0;
    async function walk(dir){
        for(const name of fs.readdirSync(dir).sort()){
            const file=path.join(dir,name),rel=path.relative(root,file),stat=fs.lstatSync(file);
            if(stat.isSymbolicLink()){
                const link=fs.readlinkSync(file);
                if(path.isAbsolute(link)||!inside(root,path.resolve(path.dirname(file),link)))throw Error('Non-relocatable artifact symlink');
                if(fs.existsSync(file)&&!inside(root,fs.realpathSync(file)))throw Error('Artifact symlink escapes root');
                digest.update(`${rel}\0link\0${link}\0`);files++;continue;
            }
            if(stat.isDirectory()){await walk(file);continue;}
            if(!stat.isFile())throw Error('Unsupported artifact file type');
            const content=createHash('sha256');for await(const chunk of fs.createReadStream(file))content.update(chunk);
            digest.update(`${rel}\0${stat.mode&0o777}\0${content.digest('hex')}\0`);files++;bytes+=stat.size;
        }
    }
    await walk(root);return {sha256:digest.digest('hex'),files,bytes};
}
function noAncestorPackages(root){
    for(let dir=path.dirname(root);;dir=path.dirname(dir)){
        if(fs.existsSync(path.join(dir,'node_modules')))throw Error('Execution tree has a host node_modules ancestor');
        if(path.dirname(dir)===dir)break;
    }
}
function makeEnvironment(root,item,ports,node){
    const roots={HOME:'home',TMPDIR:'tmp',CLI_JAW_HOME:item.role,CLI_JAW_DASHBOARD_HOME:'dashboard',
        XDG_CONFIG_HOME:'xdg/config',XDG_CACHE_HOME:'xdg/cache',XDG_DATA_HOME:'xdg/data',XDG_STATE_HOME:'xdg/state',
        CODEX_HOME:'providers/codex',CLAUDE_CONFIG_DIR:'providers/claude',PI_CODING_AGENT_DIR:'providers/pi',
        USERPROFILE:'home',APPDATA:'xdg/data',LOCALAPPDATA:'xdg/cache',TEMP:'tmp',TMP:'tmp'};
    for(const suffix of [...Object.values(roots),'worker','manager','project','electron/userData','electron/sessionData','electron/logs','electron/crashDumps'])
        fs.mkdirSync(path.join(root,suffix),{recursive:true,mode:0o700});
    const osPaths=process.platform==='win32'?[path.join(process.env['SystemRoot']??process.env['SYSTEMROOT']??'C:\\Windows','System32')]:['/usr/bin','/bin','/usr/sbin','/sbin'];
    const env={PATH:[path.dirname(node),...osPaths].join(path.delimiter),LANG:'en_US.UTF-8',LC_ALL:'C',NO_COLOR:'1',
        CLI_JAW_ISOLATED_QA_ROOT:root,DASHBOARD_SCAN_FROM:String(ports.worker),DASHBOARD_PORT:String(ports.manager),
        DASHBOARD_PREVIEW_FROM:String(ports.preview),DASHBOARD_SCAN_COUNT:'1',PORT:String(ports.worker),HOST:'127.0.0.1',
        CLI_JAW_SKIP_AUTOMATION_PRIME:'1',JAW_OPEN_BROWSER:'0',JAW_DASHBOARD_OPEN:'0',JAW_SKILLS_SOURCE:'local'};
    for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT'])if(process.env[key]!==undefined)env[key]=process.env[key];
    for(const [key,suffix] of Object.entries(roots))env[key]=path.join(root,suffix);
    fs.writeFileSync(path.join(env.CLI_JAW_HOME,'settings.json'),JSON.stringify({workingDir:path.join(root,'project'),
        permissions:'auto',messaging:{enabledChannels:[]},memory:{enabled:false}}),{mode:0o600});
    fs.writeFileSync(path.join(env.CLI_JAW_HOME,'mcp.json'),'{"servers":{}}',{mode:0o600});
    return env;
}
async function ownPort(onRequest){
    const server=http.createServer(onRequest);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return {server,port:server.address().port};
}
async function closePort(slot){
    slot.server.closeAllConnections();if(!slot.server.listening)return;
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Owned listener did not close')),5000);
        slot.server.close(error=>{clearTimeout(timer);error?reject(error):resolve();});
    });
}
async function portAbsent(port){
    const server=http.createServer();
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return true;}
    catch{return false;}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
}
async function health(url){
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(2000)});
    if(response.status!==200)throw Error(`Health HTTP ${response.status}`);
    const reader=response.body?.getReader();if(!reader)throw Error('Health response has no body');
    let bytes=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>32768)throw Error('Health body overflow');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function probe(executionRoot,runRoot,item,timeoutMs,shutdownMs){
    const root=resolveCanonicalDirectory(fs.mkdtempSync(path.join(runRoot,`${item.id}-`)));
    const row={id:item.id,kind:item.kind,root,ok:false,closed:false,imported:false,listening:false,httpReady:false,stopAcknowledged:false,issues:[]};
    const slots=[];let child,retired=false,pid,code=null,signal=null,output='',outputBytes=0,messages=0,stopSent=false;
    const fail=reason=>{if(!row.issues.includes(reason)&&row.issues.length<32)row.issues.push(reason);};
    const sendSignal=name=>{
        if(!child||retired||!pid||child.pid!==pid||child.exitCode!==null||child.signalCode!==null)return false;
        try{if(!child.kill(name)){retired=true;return false;}return true;}catch{retired=true;fail('signal failure');return false;}
    };
    try{
        for(const role of ['worker','manager','preview'])slots.push(await ownPort((req,res)=>{
            // Only a Manager's intentionally offline worker-health fixture is expected.
            const expected=item.id==='manager'&&role==='worker'&&req.method==='GET'&&req.url==='/api/health';
            if(!expected)fail('unexpected auxiliary-port request');
            res.writeHead(expected?503:404,{'content-type':'application/json'}).end('{"ok":false}');
        }));
        const ports={worker:slots[0].port,manager:slots[1].port,preview:slots[2].port};
        const primary=item.role==='worker'?ports.worker:ports.manager;
        const node=path.join(executionRoot,process.platform==='win32'?'node.exe':'node');
        const env=makeEnvironment(root,item,ports,node),nonce=randomBytes(24).toString('hex');
        await closePort(slots[item.role==='worker'?0:1]);
        row.command=[node,childEntry,executionRoot,item.id,nonce];row.ports=ports;row.environmentKeys=Object.keys(env).sort();
        child=spawn(node,[childEntry,executionRoot,item.id,nonce],{cwd:path.join(root,'project'),env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
        pid=child.pid;row.pid=pid??null;
        child.once('error',error=>{retired=true;fail(`spawn/error:${error.code??'unknown'}`);});
        child.once('exit',(value,sig)=>{retired=true;code=value;signal=sig;});
        child.once('close',(value,sig)=>{retired=true;row.closed=true;code=value;signal=sig;});
        child.on('message',value=>{
            if(row.closed)return;
            if(++messages>32||!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>32768){fail('IPC bound/shape');return;}
            const allowed=['version','caseId','nonce','kind','pid','node','executable','platform','arch','port','address','error'];
            if(Object.keys(value).some(key=>!allowed.includes(key))||value.version!==1||value.caseId!==item.id||value.nonce!==nonce||value.pid!==pid){fail('IPC identity');return;}
            if(value.kind==='error'){fail(`child:${String(value.error).slice(0,120)}`);return;}
            if(value.kind==='imported'){
                const key=file=>process.platform==='win32'?path.normalize(file).toLowerCase():path.normalize(file);
                if(row.imported||typeof value.node!=='string'||typeof value.executable!=='string'||key(value.executable)!==key(node)){fail('duplicate/invalid import receipt');return;}
                row.imported=true;row.node=value.node;row.executable=value.executable;row.platform=value.platform;row.arch=value.arch;
            }else if(value.kind==='listening'){
                if(row.listening||item.kind!=='server'||value.port!==primary||value.address!=='127.0.0.1'){fail('listener identity');return;}
                row.listening=true;
            }else if(value.kind==='stopping'){
                if(!stopSent||row.stopAcknowledged){fail('unexpected stop receipt');return;}row.stopAcknowledged=true;
            }else fail('unknown IPC kind');
        });
        const receive=chunk=>{outputBytes+=chunk.length;if(outputBytes>MAX_OUTPUT){fail('output overflow');return;}output+=chunk.toString();};
        child.stdout.on('data',receive);child.stderr.on('data',receive);
        const deadline=Date.now()+timeoutMs;let stopDeadline;
        while(!row.closed&&!row.issues.length){
            if(Date.now()>=(stopDeadline??deadline)){fail(stopSent?'stop timeout':'startup/completion timeout');break;}
            if(item.kind==='server'&&row.imported&&row.listening&&!stopSent){
                const body=await health(`http://127.0.0.1:${primary}${item.healthPath}`);
                if(row.closed||body.ok!==true)throw Error('Health did not confirm a live application');
                if(item.id==='manager'&&(body.pid!==pid||body.port!==primary||body.rangeFrom!==ports.worker||body.rangeTo!==ports.worker))throw Error('Manager health identity mismatch');
                if(item.id==='worker'&&typeof body.version!=='string')throw Error('Worker health version missing');
                row.httpReady=true;row.health=body;stopSent=true;stopDeadline=Date.now()+shutdownMs;
                child.send({kind:'stop',caseId:item.id,nonce},error=>{if(error)fail('stop dispatch failed');});
            }
            await pause(10);
        }
        if(item.kind==='server'&&(!row.httpReady||!row.stopAcknowledged))fail('server exited before owned readiness/stop');
        if(!row.imported)fail('no import completion');
    }catch(error){fail(String(error.message??error).slice(0,240));}
    finally{
        if(child&&!row.closed){
            sendSignal('SIGTERM');let until=Date.now()+shutdownMs;
            while(!row.closed&&Date.now()<until)await pause(10);
            if(!row.closed){fail('unproven cooperative cleanup');sendSignal('SIGKILL');until=Date.now()+shutdownMs;while(!row.closed&&Date.now()<until)await pause(10);}
            if(!row.closed){fail('child close unproven');child.stdout?.destroy();child.stderr?.destroy();child.disconnect?.();child.unref();}
        }
        for(const slot of slots)try{await closePort(slot);}catch{fail('auxiliary close unproven');}
        row.portsAbsent=[];for(const slot of slots)row.portsAbsent.push(await portAbsent(slot.port));
        row.groupAbsent=process.platform==='win32'?null:false;
        if(process.platform!=='win32'&&pid){try{process.kill(-pid,0);}catch(error){if(error.code==='ESRCH')row.groupAbsent=true;}}
        const ledger=path.join(root,'boundary.jsonl');
        try{
            if(fs.existsSync(ledger)&&fs.statSync(ledger).size>1024*1024)throw Error('Boundary file overflow');
            row.boundary=fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
        }
        catch{row.boundary=[];fail('boundary evidence unreadable');}
        const pending=new Set();
        for(const event of row.boundary){
            if(!event||!['metadata','blocked-credential','unavailable-discovery','forbidden-process','forbidden-network','forbidden-listener','fetch','boundary-overflow'].includes(event.kind)){
                fail('unknown boundary record');continue;
            }
            if(event.phase==='start')pending.add(event.ticket);if(event.phase==='closed')pending.delete(event.ticket);
            if(['forbidden-process','forbidden-network','forbidden-listener','boundary-overflow'].includes(event.kind))fail(event.kind);
        }
        if(pending.size)fail('metadata child completion unproven');
        row.exitCode=code;row.signal=signal;row.outputBytes=outputBytes;row.output=redact(output);row.rootRemoved=false;
        if(!row.closed||code!==0||signal||row.groupAbsent===false||row.portsAbsent.some(value=>!value))fail('runtime cleanup not certified');
        row.ok=row.issues.length===0;
    }
    return row;
}

export async function runSidecarSmoke(options){
    const timeoutMs=options.timeoutMs??30000,shutdownMs=options.shutdownMs??5000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>30000||!Number.isFinite(shutdownMs)||shutdownMs<=0||shutdownMs>5000)throw Error('Invalid bounded smoke deadline');
    const source=safeDirectory(options.serverRoot);
    if(fs.existsSync(path.join(source,'.env')))throw Error('Artifact .env is forbidden');
    let requestedReport;
    if(options.reportPath!==undefined){
        if(typeof options.reportPath!=='string'||!options.reportPath)throw Error('Invalid report path');
        const candidate=path.resolve(options.reportPath);
        requestedReport=path.join(resolveCanonicalDirectory(path.dirname(candidate)),path.basename(candidate));
        if(inside(source,requestedReport))throw Error('Report destination must be outside the original artifact');
    }
    const temporary=resolveCanonicalDirectory(os.tmpdir());
    if(inside(source,temporary))throw Error('Smoke temp directory must be outside the original artifact');
    const node=path.join(source,process.platform==='win32'?'node.exe':'node');
    for(const file of [node,path.join(source,'dist/src/shared/isolated-qa.js'),...SMOKE_CASES.map(item=>path.join(source,item.relative))])
        if(!fs.statSync(file).isFile())throw Error('Required sidecar input is missing');
    fs.accessSync(node,fs.constants.X_OK);
    const runRoot=resolveCanonicalDirectory(fs.mkdtempSync(path.join(temporary,'jaw-sidecar-smoke-')));
    const reportPath=requestedReport??path.join(runRoot,'report.json');
    // Reserve before executing anything; never overwrite an existing result.
    let reportFd;try{reportFd=fs.openSync(reportPath,'wx',0o600);}catch(error){fs.rmSync(runRoot,{recursive:true});throw error;}
    const executionRoot=path.join(runRoot,'artifact');const result={ok:false,code:1,reportPath,runRoot,source,probes:[]};
    try{
        noAncestorPackages(executionRoot);
        result.original=await treeIdentity(source);
        await fs.promises.cp(source,executionRoot,{recursive:true,dereference:false,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});
        const copied=await treeIdentity(executionRoot);
        if(JSON.stringify(copied)!==JSON.stringify(result.original))throw Error('Artifact copy identity mismatch');
        result.executionRoot=executionRoot;
        for(const item of SMOKE_CASES){
            const row=await probe(executionRoot,runRoot,item,timeoutMs,shutdownMs);result.probes.push(row);
            if(JSON.stringify(await treeIdentity(executionRoot))!==JSON.stringify(copied)){row.ok=false;row.issues.push('artifact changed during execution');}
            if(!row.closed||row.groupAbsent===false)break;
        }
        result.originalAfter=await treeIdentity(source);
        if(JSON.stringify(result.originalAfter)!==JSON.stringify(result.original))throw Error('Original artifact changed during smoke');
        result.ok=result.probes.length===SMOKE_CASES.length&&result.probes.every(row=>row.ok);result.code=result.ok?0:1;
    }catch(error){result.error=String(error.message??error).slice(0,500);}
    // Full evidence precedes payload deletion. Reports are intentionally retained.
    try{fs.writeFileSync(reportFd,JSON.stringify(result,null,2));fs.fsyncSync(reportFd);}finally{fs.closeSync(reportFd);}
    const cleanup={reportPath,removed:[],retained:[],ok:result.ok};
    if(result.ok){
        for(const dir of [...result.probes.map(row=>row.root),executionRoot]){
            try{fs.rmSync(dir,{recursive:true});cleanup.removed.push(dir);}catch{cleanup.retained.push(dir);cleanup.ok=false;}
        }
    }else cleanup.retained=[...result.probes.map(row=>row.root),executionRoot];
    fs.writeFileSync(reportPath+'.cleanup.json',JSON.stringify(cleanup,null,2),{flag:'wx',mode:0o600});
    if(!cleanup.ok){result.ok=false;result.code=1;}
    return {...result,probes:result.probes.map(row=>({...row,rootRemoved:!fs.existsSync(row.root)})),cleanup};
}

function parseArgs(args){
    const options={};for(let i=0;i<args.length;i++){
        const flag=args[i];if(!['--server-root','--report'].includes(flag)||options[flag]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid sidecar smoke arguments');
        options[flag]=args[++i];
    }return options;
}
async function main(argv){
    const usage='Usage: check-sidecar-smoke.mjs [--server-root DIR] [--report NEW_FILE]';
    if(argv.length===1&&['--help','-h'].includes(argv[0])){console.log(usage);return;}
    let args;
    try{args=parseArgs(argv);}
    catch(error){console.error(`${String(error.message??error)}\n${usage}`);process.exitCode=2;return;}
    try{
        const root=path.resolve(args['--server-root']??'electron/sidecar/server');
        if(!fs.existsSync(root)){
            if(args['--server-root']||process.env['JAW_GATE_REQUIRE_SIDECAR']==='1'){
                console.error(`Sidecar not bundled at ${root}, but the caller required a real smoke test`);process.exitCode=1;
            }else{
                console.log(`Sidecar not bundled at ${root} — skipping smoke; SKIPPED (not verified, nothing imported)`);process.exitCode=3;
            }
            return;
        }
        const result=await runSidecarSmoke({serverRoot:root,reportPath:args['--report']});
        console.log(`Sidecar smoke ${result.ok?'PASS':'FAIL'}: ${result.probes.length} critical surfaces; report ${result.reportPath}`);
        process.exitCode=result.code;
    }catch(error){console.error(`Sidecar smoke failed: ${String(error.message??error)}`);process.exitCode=1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(process.argv.slice(2));
