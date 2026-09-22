/** Import a Developer ID p12 into a short-lived, workflow-owned keychain. */
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYCHAIN_PATTERN=/^cli-jaw-signing-[a-f0-9]{24}\.keychain-db$/;

export function decodeCertificate(input) {
    if(typeof input!=='string'||input.trim()==='')throw Error('MAC_CSC_LINK is required');
    const encoded=input.trim().replace(/^data:[^,]*;base64,/i,'').replace(/\s+/g,'');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4===1)throw Error('MAC_CSC_LINK must contain valid base64');
    const decoded=Buffer.from(encoded,'base64');
    if(decoded.length===0)throw Error('MAC_CSC_LINK must contain valid base64');
    return decoded;
}

function defaultRunSecurity(args) {
    const result=childProcess.spawnSync('/usr/bin/security',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(result.error||result.status!==0)throw Error('security command failed');
    return result.stdout??'';
}

function required(env,name) {
    const value=env[name];
    if(typeof value!=='string'||value==='')throw Error(`${name} is required`);
    return value;
}

function ownedKeychainPath(value,env) {
    const temp=path.resolve(required(env,'RUNNER_TEMP'));
    const candidate=path.resolve(value);
    if(path.dirname(candidate)!==temp||!KEYCHAIN_PATTERN.test(path.basename(candidate))) {
        throw Error('refusing to remove a keychain not owned by this workflow');
    }
    return candidate;
}

function removeKeychain(keychain,runSecurity,removeFile) {
    try { runSecurity(['delete-keychain',keychain]); }
    catch { /* The contained filesystem fallback still removes a partially created keychain. */ }
    removeFile(keychain,{force:true,recursive:true});
}

export function importSigningCertificate(options={}) {
    const env=options.env??process.env;
    const runSecurity=options.runSecurity??defaultRunSecurity;
    const randomBytesFn=options.randomBytesFn??crypto.randomBytes;
    const writeFile=options.writeFile??fs.writeFileSync;
    const appendFile=options.appendFile??fs.appendFileSync;
    const removeFile=options.removeFile??fs.rmSync;
    const temp=path.resolve(required(env,'RUNNER_TEMP'));
    const output=required(env,'GITHUB_OUTPUT');
    const certificatePassword=required(env,'MAC_CSC_KEY_PASSWORD');
    const teamId=required(env,'EXPECTED_APPLE_TEAM_ID');
    if(!/^[A-Z0-9]{10}$/.test(teamId))throw Error('EXPECTED_APPLE_TEAM_ID is invalid');

    const token=randomBytesFn(12).toString('hex');
    const keychain=ownedKeychainPath(path.join(temp,`cli-jaw-signing-${token}.keychain-db`),env);
    const certificate=path.join(temp,`cli-jaw-signing-${token}.p12`);
    const keychainPassword=randomBytesFn(32).toString('hex');
    let keychainCreated=false;
    let stage='certificate decoding';
    try {
        const payload=decodeCertificate(required(env,'MAC_CSC_LINK'));
        writeFile(certificate,payload,{flag:'wx',mode:0o600});
        stage='keychain creation';
        // A failing `security create-keychain` can still leave a partial file.
        // Mark ownership before invoking it so every exit path attempts cleanup.
        keychainCreated=true;
        runSecurity(['create-keychain','-p',keychainPassword,keychain]);
        runSecurity(['set-keychain-settings','-lut','21600',keychain]);
        runSecurity(['unlock-keychain','-p',keychainPassword,keychain]);
        stage='certificate import';
        runSecurity(['import',certificate,'-k',keychain,'-P',certificatePassword,
            '-T','/usr/bin/codesign','-T','/usr/bin/productbuild']);
        stage='key partition configuration';
        runSecurity(['set-key-partition-list','-S','apple-tool:,apple:,codesign:','-s','-k',keychainPassword,keychain]);
        stage='identity verification';
        const identities=runSecurity(['find-identity','-v','-p','codesigning',keychain]);
        const escapedTeam=teamId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        if(!new RegExp(`Developer ID Application:.*\\(${escapedTeam}\\)`).test(identities))throw Error('identity unavailable');
        appendFile(output,`keychain=${keychain}\n`,{encoding:'utf8'});
        return keychain;
    } catch {
        if(keychainCreated)removeKeychain(keychain,runSecurity,removeFile);
        throw Error(`macOS signing certificate import failed during ${stage}`);
    } finally {
        removeFile(certificate,{force:true});
    }
}

export function cleanupSigningKeychain(value,options={}) {
    const env=options.env??process.env;
    const keychain=ownedKeychainPath(value,env);
    removeKeychain(keychain,options.runSecurity??defaultRunSecurity,options.removeFile??fs.rmSync);
}

function main() {
    const [mode,value]=process.argv.slice(2);
    if(mode==='import')importSigningCertificate();
    else if(mode==='cleanup')cleanupSigningKeychain(value??process.env.MAC_SIGNING_KEYCHAIN??'');
    else throw Error('usage: import-mac-signing-certificate.mjs <import|cleanup> [keychain]');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    try { main(); }
    catch(error) { console.error(`::error::${error instanceof Error?error.message:'macOS signing keychain operation failed'}`);process.exitCode=1; }
}
