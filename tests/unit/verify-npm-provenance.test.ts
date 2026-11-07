import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNpmProvenance } from '../../scripts/verify-npm-provenance.mjs';

const version = '2.17.73';
const sha = 'aca08d9148e368ecf557240a25a0b708cd795a94';
const repository = 'lidge-ai/cli-jaw';
const bytes = Buffer.alloc(64, 42);
const integrity = `sha512-${bytes.toString('base64')}`;
const payload = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: `pkg:npm/cli-jaw@${version}`, digest: { sha512: bytes.toString('hex') } }],
    predicate: {
        buildDefinition: {
            externalParameters: {
                workflow: {
                    repository: `https://github.com/${repository}`,
                    path: '.github/workflows/publish.yml',
                },
            },
            resolvedDependencies: [{ digest: { gitCommit: sha } }],
        },
    },
};
const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
        attestations: [{
            predicateType: 'https://slsa.dev/provenance/v1',
            bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') } },
        }],
    }),
});

test('registry provenance binds package, workflow and commit', async () => {
    assert.equal(await verifyNpmProvenance({ version, sha, repository, integrity, fetchImpl }), true);
    await assert.rejects(verifyNpmProvenance({ version, sha: '0'.repeat(40), repository, integrity, fetchImpl }));
    await assert.rejects(verifyNpmProvenance({ version, sha, repository, integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, fetchImpl }));
    await assert.rejects(verifyNpmProvenance({ version, sha, repository, integrity, fetchImpl: async () => ({ ok: false, status: 503 }) }));
});
