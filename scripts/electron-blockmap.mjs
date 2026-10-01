#!/usr/bin/env node
/**
 * Rebuild a .blockmap with electron-builder's own implementation.
 *
 * electron-builder 26.15 replaced the app-builder-bin `blockmap` command with
 * app-builder-lib's pure-TS buildBlockMap and dropped app-builder-bin from its
 * dependency tree. This helper keeps the old command-line contract
 * (`blockmap --input <file> --output <file.blockmap>`, JSON {size, sha512} on
 * stdout) so notarize-mac-dmg.mjs can stay synchronous and test-injectable.
 * The gzip format matches createBlockmap in
 * app-builder-lib/out/targets/differentialUpdateInfoBuilder.js.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== 'blockmap' || args[1] !== '--input' || args[3] !== '--output') {
  console.error('usage: electron-blockmap.mjs blockmap --input <file> --output <file.blockmap>');
  process.exit(2);
}
const electronRequire = createRequire(join(projectRoot, 'electron', 'package.json'));
const { buildBlockMap } = electronRequire('app-builder-lib/out/targets/blockmap/blockmap.js');
const info = await buildBlockMap(resolve(args[2]), 'gzip', resolve(args[4]));
process.stdout.write(JSON.stringify({ size: info.size, sha512: info.sha512 }));

