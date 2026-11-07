'use strict';

const fs = require('node:fs');
const path = require('node:path');

function restoreSpawnHelperModes(root, platform = process.platform) {
    const result = { checked: [], changed: [] };
    if (platform === 'win32' || !fs.existsSync(root)) return result;

    const candidates = [
        path.join(root, 'build', 'Release', 'spawn-helper'),
        path.join(root, 'build', 'Debug', 'spawn-helper'),
    ];
    const prebuilds = path.join(root, 'prebuilds');
    let directories;
    try {
        directories = fs.readdirSync(prebuilds, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        directories = [];
    }
    for (const entry of directories) {
        if (entry.isDirectory() && !entry.name.startsWith('win32-')) {
            candidates.push(path.join(prebuilds, entry.name, 'spawn-helper'));
        }
    }

    for (const candidate of candidates) {
        let stat;
        try {
            stat = fs.lstatSync(candidate);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (!stat.isFile()) continue;
        result.checked.push(candidate);
        const from = stat.mode & 0o7777;
        // node-pty prebuilds ship helpers as 0644; native-load and PTY spawning need execute bits.
        const to = from | ((from & 0o444) >> 2);
        if (from !== to) {
            fs.chmodSync(candidate, to);
            result.changed.push({ path: candidate, from, to });
        }
    }
    return result;
}

module.exports = { restoreSpawnHelperModes };

if (require.main === module) {
    const root = process.argv[2] || path.join(process.cwd(), 'node_modules', 'node-pty');
    if (process.platform === 'win32') {
        console.log('Skipping spawn-helper mode restoration on Windows.');
    } else if (!fs.existsSync(root)) {
        console.log(`node-pty root not found: ${root}; skipping spawn-helper mode restoration.`);
    } else {
        const { changed } = restoreSpawnHelperModes(root);
        for (const entry of changed) {
            console.log(`Restored ${entry.path}: ${entry.from.toString(8)} -> ${entry.to.toString(8)}`);
        }
    }
}
