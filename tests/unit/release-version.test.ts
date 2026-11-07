import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReleaseVersion, compareReleaseVersions } from '../../scripts/release-version.mjs';
test('stable continues a preview, but stable packages always bump', () => {
    assert.equal(resolveReleaseVersion({ channel: 'stable', pkgVersion: '2.18.0-preview.1', npmLatest: '2.17.73' }).version, '2.18.0');
    assert.equal(resolveReleaseVersion({ channel: 'stable', pkgVersion: '2.17.73', npmLatest: '2.17.73', pkgPublished: false }).version, '2.17.74');
});
test('preview requires a newer core and increasing stamp', () => {
    assert.equal(resolveReleaseVersion({ channel: 'preview', pkgVersion: '2.17.73', npmLatest: '2.17.73', stamp: '20261107000000' }).version, '2.17.74-preview.20261107000000');
    assert.ok(compareReleaseVersions('2.18.0', '2.18.0-preview.1') > 0);
    assert.throws(() => resolveReleaseVersion({ channel: 'stable', pkgVersion: '2.18.0', npmLatest: '2.17.73', explicitBase: '2.17.74' }));
});
test('version policy rejects invalid channels, stamps, bases and dist-tag rollback', async () => {
    const { assertPublishable } = await import('../../scripts/release-version.mjs');
    assert.throws(() => resolveReleaseVersion({ channel: 'other', pkgVersion: '1.2.3', npmLatest: '1.2.2' }));
    assert.throws(() => resolveReleaseVersion({ channel: 'preview', pkgVersion: '1.2.3', npmLatest: '1.2.2', stamp: 'bad' }));
    assert.throws(() => resolveReleaseVersion({ channel: 'stable', pkgVersion: '1.2.3', npmLatest: '1.2.3', explicitBase: '1.2.3' }));
    assert.equal(resolveReleaseVersion({ channel: 'stable', pkgVersion: '1.2.3', npmLatest: '1.2.3', bump: 'minor' }).version, '1.3.0');
    assert.throws(() => assertPublishable({ channel: 'stable', candidate: '1.2.3', latest: '1.2.3' }));
    assert.throws(() => assertPublishable({ channel: 'preview', candidate: '1.2.3-preview.20261107000000', latest: '1.2.3' }));
    assert.throws(() => assertPublishable({ channel: 'preview', candidate: '1.2.4-preview.20261107000000', latest: '1.2.3', preview: '1.2.4-preview.20261108000000' }));
});
