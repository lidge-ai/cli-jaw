/** Private child boundary of the sidecar smoke CLI; catalogue import is inert. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SMOKE_CASES = Object.freeze([
    Object.freeze({ id:'telegram', relative:'dist/src/telegram/bot.js', kind:'import', role:'worker', healthPath:null }),
    Object.freeze({ id:'worker', relative:'dist/server.js', kind:'server', role:'worker', healthPath:'/api/health' }),
    Object.freeze({ id:'manager', relative:'dist/src/manager/server.js', kind:'server', role:'manager', healthPath:'/api/dashboard/health' }),
]);

/** Deliver the child's existing SIGTERM handler without asking Windows to emulate a POSIX self-signal. */
export function requestGracefulStop(platform=process.platform,target=process) {
    if(platform==='win32')target.emit('SIGTERM');
    else target.kill(target.pid,'SIGTERM');
}

async function runChild() {
    const [root, id, nonce] = process.argv.slice(2);
    if (process.argv.length!==5 || !root || fs.realpathSync(root)!==root || !/^[a-f0-9]{48}$/.test(nonce??'')) throw Error('Invalid smoke child input');
    const item=SMOKE_CASES.find(value=>value.id===id); if(!item)throw Error('Unknown smoke case');
    if(!process.send || !process.connected)throw Error('Smoke requires its private IPC channel');
    if(fs.existsSync(path.join(root,'.env')))throw Error('Artifact .env is forbidden');
    const {readIsolatedQaPolicy,isolatedQaEnvironment}=await import(pathToFileURL(path.join(root,'dist/src/shared/isolated-qa.js')).href);
    const policy=readIsolatedQaPolicy(process.env,item.role); if(!policy)throw Error('Missing isolated smoke policy');
    const cleanEnv=isolatedQaEnvironment(policy,process.env);
    cleanEnv['HOST']='127.0.0.1';
    for(const key of Object.keys(process.env))delete process.env[key];
    Object.assign(process.env,cleanEnv);
    const ledger=path.join(policy.root,'boundary.jsonl');
    let records=0, sequence=0, stopping=false, boundaryFailed=false;
    const message=(kind,data={})=>{
        if(process.connected)process.send({version:1,caseId:id,nonce,kind,pid:process.pid,...data});
    };
    const record=data=>{
        try {
            if(++records<=256)fs.appendFileSync(ledger,JSON.stringify(data)+'\n',{mode:0o600});
            else if(records===257)fs.appendFileSync(ledger,'{"kind":"boundary-overflow"}\n');
        } catch(error) { boundaryFailed=true;message('error',{error:'boundary-write-failed'});throw error; }
    };
    process.on('exit',()=>{if(boundaryFailed)process.exitCode=1;});
    const original={...childProcess};
    const absent=path.join(policy.root,`.unavailable-${nonce}`);
    const sysRoot=cleanEnv['SystemRoot']??cleanEnv['SYSTEMROOT'];
    const which=process.platform==='win32'?path.join(sysRoot??'','System32','where.exe'):'/usr/bin/which';
    const ps=fs.existsSync('/bin/ps')?'/bin/ps':'/usr/bin/ps';
    const powershell=path.join(sysRoot??'','System32','WindowsPowerShell','v1.0','powershell.exe');
    function classify(command,args,opts) {
        if(typeof command!=='string'||!args.every(value=>typeof value==='string')||opts.shell||opts.detached) return {kind:'forbidden-process'};
        const base=path.basename(command).toLowerCase();
        const name=/^[a-z0-9_-]+(?:\.exe)?$/i;
        if((command==='which'||command==='where.exe'||command===which)
            && ((args.length===1&&name.test(args[0]))||(args.length===2&&args[0]==='-a'&&name.test(args[1]))))
            return {kind:'metadata',command:which,args:process.platform==='win32'?[args.at(-1)]:['-a',args.at(-1)]};
        // scanSystemProfile resolves the known npm.cmd shim through this exact,
        // argv-separated wrapper on Windows. Keep the host probe unavailable;
        // accepting only the fixed shape does not open a general cmd.exe path.
        if(process.platform==='win32'&&base==='cmd.exe'
            && JSON.stringify(args)===JSON.stringify(['/d','/s','/c','npm.cmd','--version']))
            return {kind:'unavailable-discovery'};
        if((command==='ps'||command===ps)&&JSON.stringify(args)===JSON.stringify(['-o','lstart=','-p',String(process.pid)]))
            return {kind:'metadata',command:ps,args};
        if((command==='powershell.exe'||command===powershell)&&JSON.stringify(args)===JSON.stringify([
            '-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`]))
            return {kind:'metadata',command:powershell,args};
        if((command==='node'||(process.platform==='win32'&&command==='node.exe')||command===process.execPath)&&args.length===1&&args[0]==='--version')
            return {kind:'metadata',command:process.execPath,args};
        // Fresh memory bootstrap asks for these two owned-project facts. Keep
        // them unavailable: no Git process, hooks, config or remote is consulted.
        if(command==='git'&&args[0]==='-C'&&args[1]===path.join(policy.root,'project')
            && ((args.length===5&&args[2]==='remote'&&args[3]==='get-url'&&args[4]==='origin')
                ||(args.length===4&&args[2]==='branch'&&args[3]==='--show-current')))
            return {kind:'unavailable-discovery'};
        if((base==='security'&&['find-generic-password','find-internet-password'].includes(args[0]))
            ||(base==='gh'&&args[0]==='auth'&&args[1]==='token'))return {kind:'blocked-credential'};
        if(args.length===1&&args[0]==='--version')return {kind:'unavailable-discovery'};
        return {kind:'forbidden-process'};
    }
    function launch(method,command,args=[],opts={},callback,forcedKind) {
        const choice=forcedKind?{kind:forcedKind}:classify(command,args,opts);
        const ticket=++sequence;
        const diagnostic=choice.kind==='forbidden-process'&&typeof command==='string'
            ?{executable:path.basename(command).toLowerCase(),argumentCount:args.length}
            :{};
        record({kind:choice.kind,method,ticket,phase:'start',...diagnostic});
        if(fs.existsSync(absent))throw Error('Unavailable executable path unexpectedly exists');
        const selected=choice.command??absent;
        const selectedArgs=choice.args??[];
        const options={cwd:policy.home,env:{...cleanEnv},windowsHide:true,
            timeout:Math.min(Number.isFinite(opts.timeout)&&opts.timeout>0?opts.timeout:3000,5000),
            maxBuffer:Math.min(Number.isFinite(opts.maxBuffer)&&opts.maxBuffer>0?opts.maxBuffer:65536,262144),
            ...(opts.encoding===undefined?{}:{encoding:opts.encoding})};
        if(method==='execFileSync'||method==='spawnSync') {
            try {return original[method](selected,selectedArgs,options);}
            finally {record({kind:choice.kind,method,ticket,phase:'closed'});}
        }
        const child=method==='spawn'?original.spawn(selected,selectedArgs,{...options,stdio:['ignore','pipe','pipe']})
            :original.execFile(selected,selectedArgs,options,callback);
        record({kind:choice.kind,method,ticket,phase:'spawned',pid:child.pid??null});
        child.once('close',()=>record({kind:choice.kind,method,ticket,phase:'closed'}));
        return child;
    }
    const unpack=rest=>{
        const args=Array.isArray(rest[0])?rest.shift():[];
        const callback=typeof rest.at(-1)==='function'?rest.pop():undefined;
        const opts=rest[0]&&typeof rest[0]==='object'?rest[0]:{};
        return {args,opts,callback};
    };
    for(const method of ['execFileSync','spawnSync','execFile','spawn']) childProcess[method]=function(command,...rest) {
        const {args,opts,callback}=unpack(rest);return launch(method,command,args,opts,callback);
    };
    for(const method of ['execSync','exec']) childProcess[method]=function(command,...rest) {
        const {opts,callback}=unpack(rest);
        const lookup=typeof command==='string'?/^(?:command -v|which(?: -a)?) ([a-z0-9_-]+)(?: 2>\/dev\/null)?$/i.exec(command):null;
        if(lookup)return launch(method==='execSync'?'execFileSync':'execFile',which,[lookup[1]],opts,callback);
        const credential=typeof command==='string'&&(command==='gh auth token'
            ||(/^security find-(?:generic|internet)-password(?: |$)/.test(command)&&!/[;&|<>`$()\r\n]/.test(command)));
        const kind=credential?'blocked-credential':'forbidden-process';
        return launch(method==='execSync'?'execFileSync':'execFile',absent,[],opts,callback,kind);
    };
    for(const method of ['exec','execFile'])Object.defineProperty(childProcess[method],promisify.custom,{value:(...args)=>{
        let child;
        const promise=new Promise((resolve,reject)=>{child=childProcess[method](...args,(error,stdout,stderr)=>{
            if(error){Object.assign(error,{stdout,stderr});reject(error);}else resolve({stdout,stderr});
        });});
        promise.child=child;return promise;
    }});
    childProcess.fork=function(){record({kind:'forbidden-process',method:'fork'});throw Error('Smoke cannot fork application work');};
    syncBuiltinESMExports();

    const primary=item.role==='worker'?policy.workerPort:policy.managerPort;
    const listenOriginal=net.Server.prototype.listen;
    net.Server.prototype.listen=function(...args) {
        const options=typeof args[0]==='object'&&args[0]!==null?args[0]:{port:args[0],host:args[1]};
        if(item.kind!=='server'||Number(options.port)!==primary||options.host!=='127.0.0.1') {
            record({kind:'forbidden-listener'});throw Error('Smoke listener outside primary loopback port');
        }
        this.once('listening',()=>{
            const address=this.address();
            if(!address||typeof address==='string'||address.port!==primary||address.address!=='127.0.0.1') {
                record({kind:'forbidden-listener'});throw Error('Unexpected listener identity');
            }
            message('listening',{port:address.port,address:address.address});
        });
        return listenOriginal.apply(this,args);
    };
    const fetchOriginal=globalThis.fetch.bind(globalThis);
    globalThis.fetch=(input,init)=>{
        let url;try{url=new URL(input instanceof Request?input.url:String(input));}
        catch{record({kind:'forbidden-network'});return Promise.reject(Error('Malformed smoke URL'));}
        const method=init?.method??(input instanceof Request?input.method:'GET');
        const allowed=url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)
            &&[policy.workerPort,policy.managerPort,policy.previewPort].includes(Number(url.port))&&method==='GET';
        record({kind:allowed?'fetch':'forbidden-network',method,port:Number(url.port),path:(url.pathname+url.search).slice(0,512)});
        if(!allowed)return Promise.reject(Error('Smoke egress refused'));
        return fetchOriginal(input,{...init,redirect:'error'});
    };
    process.on('message',value=>{
        if(!value||value.kind!=='stop'||value.caseId!==id||value.nonce!==nonce||stopping)return;
        stopping=true;
        process.send({version:1,caseId:id,nonce,kind:'stopping',pid:process.pid},error=>{
            if(error||boundaryFailed)process.exit(1);
            requestGracefulStop(); // This executing process owns itself.
        });
    });
    const fatal=error=>{
        message('error',{error:String(error?.code??error?.name??'startup-error').slice(0,120)});
        fs.writeSync(2,`Sidecar smoke child error: ${String(error?.message??error).slice(0,1000)}\n`);
        process.exit(1);
    };
    process.once('uncaughtException',fatal);process.once('unhandledRejection',fatal);
    await import(pathToFileURL(path.join(root,item.relative)).href);
    if(boundaryFailed)throw Error('Boundary evidence unavailable');
    const data={version:1,caseId:id,nonce,kind:'imported',pid:process.pid,node:process.version,executable:process.execPath,platform:process.platform,arch:process.arch};
    await new Promise((resolve,reject)=>process.send(data,error=>error?reject(error):resolve()));
    // Finite imports must exit naturally: a lingering initializer is not success.
    if(item.kind==='import'&&process.connected)process.disconnect();
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    runChild().catch(error=>{fs.writeSync(2,`Sidecar smoke bootstrap failed: ${String(error?.message??error).slice(0,1000)}\n`);process.exitCode=1;if(process.connected)process.disconnect();});
}
