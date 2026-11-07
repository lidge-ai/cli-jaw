import { pathToFileURL } from 'node:url';

// npm's registry is the trust root here; this check does not verify DSSE signatures.
export function checkProvenance({ attestations, version, integrity, repository, sha }) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || '');
  if (!match) throw new Error('Missing or invalid sha512 integrity');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== match[1]) throw new Error('Invalid sha512 integrity');
  const expected = bytes.toString('hex');
  const entries = attestations?.attestations;
  if (!Array.isArray(entries)) throw new Error('Missing npm attestations');
  for (const entry of entries) {
    if (entry.predicateType !== 'https://slsa.dev/provenance/v1') continue;
    try {
      const payload = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
      const workflow = payload.predicate?.buildDefinition?.externalParameters?.workflow;
      const dependencies = payload.predicate?.buildDefinition?.resolvedDependencies;
      const subject = payload.subject?.some(s => s.name === `pkg:npm/cli-jaw@${version}` && s.digest?.sha512 === expected);
      if (payload.predicateType === 'https://slsa.dev/provenance/v1' && subject && workflow?.repository === `https://github.com/${repository}` && workflow.path === '.github/workflows/publish.yml' && Array.isArray(dependencies) && dependencies.some(d => d.digest?.gitCommit === sha)) return true;
    } catch { /* An invalid entry cannot certify the package. */ }
  }
  throw new Error('No matching npm provenance');
}
export async function verifyNpmProvenance({ version, integrity, repository, sha, fetchImpl = fetch }) {
  if (!/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(version)) throw new Error('Invalid version');
  const response = await fetchImpl(`https://registry.npmjs.org/-/npm/v1/attestations/cli-jaw@${version}`);
  if (!response.ok) throw new Error(`Attestation fetch failed: ${response.status}`);
  return checkProvenance({attestations: await response.json(), version, integrity, repository, sha});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyNpmProvenance({version:process.env.RELEASE_VERSION, integrity:process.env.NPM_INTEGRITY, repository:process.env.GITHUB_REPOSITORY, sha:process.env.GITHUB_SHA})
    .then(() => console.log('npm provenance matches release commit'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
