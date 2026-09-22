import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    cleanupSigningKeychain,
    decodeCertificate,
    importSigningCertificate,
} from '../../scripts/import-mac-signing-certificate.mjs';

test('certificate decoder accepts raw base64 and data URLs but rejects malformed input',()=>{
    const payload=Buffer.from('fixture-p12');
    assert.deepEqual(decodeCertificate(payload.toString('base64')),payload);
    assert.deepEqual(decodeCertificate(`data:application/x-pkcs12;base64,${payload.toString('base64')}`),payload);
    assert.throws(()=>decodeCertificate('%%%'),/valid base64/);
    assert.throws(()=>decodeCertificate(''),/required/);
});

test('certificate import uses the owned keychain password, verifies the team, and erases the p12',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'jaw-signing-test-'));
    const output=path.join(root,'github-output');
    const calls:string[][]=[];
    const certificatePassword='fixture-p12-secret';
    const keychainPassword='ab'.repeat(32);
    try{
        const keychain=importSigningCertificate({
            env:{
                RUNNER_TEMP:root,
                GITHUB_OUTPUT:output,
                MAC_CSC_LINK:Buffer.from('fixture-p12').toString('base64'),
                MAC_CSC_KEY_PASSWORD:certificatePassword,
                EXPECTED_APPLE_TEAM_ID:'U9ATA49N28',
            },
            randomBytesFn:size=>Buffer.alloc(size,0xab),
            runSecurity:args=>{
                calls.push([...args]);
                if(args[0]==='list-keychains'&&args.length===3)return '    "/Users/runner/Library/Keychains/login.keychain-db"\n';
                return args[0]==='find-identity'
                    ? '1) ABCDEF "Developer ID Application: Maintainer (U9ATA49N28)"\n     1 valid identities found'
                    : '';
            },
        });
        assert.equal(path.dirname(keychain),root);
        assert.match(path.basename(keychain),/^cli-jaw-signing-[a-f0-9]{24}\.keychain-db$/);
        assert.ok(calls.some(args=>args[0]==='import'&&args.includes(certificatePassword)));
        assert.ok(calls.some(args=>args[0]==='set-key-partition-list'&&args.includes(keychainPassword)));
        assert.ok(!calls.find(args=>args[0]==='set-key-partition-list')!.includes(certificatePassword));
        assert.ok(calls.some(args=>args[0]==='list-keychains'&&args[3]==='-s'
            &&args.includes(keychain)&&args.includes('/Users/runner/Library/Keychains/login.keychain-db')));
        assert.equal(fs.readFileSync(output,'utf8'),`keychain=${keychain}\n`);
        assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.p12')),false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('failed identity verification redacts secrets, erases material, and deletes the keychain',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'jaw-signing-test-'));
    const calls:string[][]=[];
    const secret='never-print-this';
    try{
        assert.throws(()=>importSigningCertificate({
            env:{RUNNER_TEMP:root,GITHUB_OUTPUT:path.join(root,'output'),MAC_CSC_LINK:Buffer.from('p12').toString('base64'),
                MAC_CSC_KEY_PASSWORD:secret,EXPECTED_APPLE_TEAM_ID:'U9ATA49N28'},
            randomBytesFn:size=>Buffer.alloc(size,0xcd),
            runSecurity:args=>{calls.push([...args]);return '';},
        }),error=>{
            assert.doesNotMatch(String(error),new RegExp(secret));
            assert.match(String(error),/identity verification/);
            return true;
        });
        assert.ok(calls.some(args=>args[0]==='delete-keychain'));
        assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.p12')),false);
        assert.equal(fs.existsSync(path.join(root,'output')),false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a partially failed keychain creation is still cleaned without exposing command output',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'jaw-signing-test-'));
    const calls:string[][]=[];
    try{
        assert.throws(()=>importSigningCertificate({
            env:{RUNNER_TEMP:root,GITHUB_OUTPUT:path.join(root,'output'),MAC_CSC_LINK:Buffer.from('p12').toString('base64'),
                MAC_CSC_KEY_PASSWORD:'fixture-secret',EXPECTED_APPLE_TEAM_ID:'U9ATA49N28'},
            randomBytesFn:size=>Buffer.alloc(size,0xef),
            runSecurity:args=>{
                calls.push([...args]);
                if(args[0]==='create-keychain')throw Error('runner detail fixture-secret');
                return '';
            },
        }),error=>{
            assert.equal(String(error).includes('fixture-secret'),false);
            assert.match(String(error),/keychain creation/);
            return true;
        });
        assert.ok(calls.some(args=>args[0]==='delete-keychain'));
        assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.p12')),false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('cleanup accepts only helper-owned keychains directly inside RUNNER_TEMP',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'jaw-signing-test-'));
    const owned=path.join(root,'cli-jaw-signing-abcdefabcdefabcdefabcdef.keychain-db');
    const calls:string[][]=[];
    fs.writeFileSync(owned,'fixture');
    try{
        assert.throws(()=>cleanupSigningKeychain('/tmp/foreign.keychain-db',{env:{RUNNER_TEMP:root},runSecurity:()=>''}),/refusing/);
        cleanupSigningKeychain(owned,{env:{RUNNER_TEMP:root},runSecurity:args=>{
            calls.push([...args]);
            if(args[0]==='list-keychains')return `    "${owned}"\n    "/Users/runner/Library/Keychains/login.keychain-db"\n`;
            if(args[0]==='delete-keychain')fs.rmSync(owned,{force:true});
            return '';
        }});
        assert.deepEqual(calls,[
            ['list-keychains','-d','user'],
            ['list-keychains','-d','user','-s','/Users/runner/Library/Keychains/login.keychain-db'],
            ['delete-keychain',owned],
        ]);
        assert.equal(fs.existsSync(owned),false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
});
