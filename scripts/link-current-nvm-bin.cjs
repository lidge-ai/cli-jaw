#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = 'cli-jaw';
const BIN_NAMES = ['cli-jaw', 'jaw'];

const repoRoot = path.resolve(__dirname, '..');
const nodeBinDir = path.dirname(process.execPath);
const nodePrefix = path.dirname(nodeBinDir);
const globalPackageDir = path.join(nodePrefix, 'lib', 'node_modules', PACKAGE_NAME);
const packageBin = path.join(globalPackageDir, 'dist', 'bin', 'cli-jaw.js');
const repoBin = path.join(repoRoot, 'dist', 'bin', 'cli-jaw.js');

function isNvmNode() {
    return process.execPath.includes(`${path.sep}.nvm${path.sep}versions${path.sep}node${path.sep}`);
}

function relativeTarget(fromPath, toPath) {
    return path.relative(path.dirname(fromPath), toPath) || path.basename(toPath);
}

function ensureSymlink(linkPath, targetPath, type) {
    const target = relativeTarget(linkPath, targetPath);
    try {
        const existing = fs.lstatSync(linkPath);
        if (!existing.isSymbolicLink()) {
            throw new Error(`${linkPath} exists and is not a symlink`);
        }
        const current = fs.readlinkSync(linkPath);
        const currentAbs = path.resolve(path.dirname(linkPath), current);
        const targetAbs = path.resolve(path.dirname(linkPath), target);
        if (currentAbs === targetAbs) return false;
        fs.unlinkSync(linkPath);
    } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
    }
    fs.symlinkSync(target, linkPath, type);
    return true;
}

function ensureRepoBinExecutable() {
    if (!fs.existsSync(repoBin)) {
        throw new Error(`build output missing: ${repoBin}`);
    }
    if (process.platform !== 'win32') {
        fs.chmodSync(repoBin, 0o755);
    }
}

function main() {
    ensureRepoBinExecutable();
    if (!isNvmNode()) {
        console.log(`[jaw:link] chmod ok; skip linking because node is not from nvm (${process.execPath})`);
        return;
    }

    try {
        const existingPackage = fs.lstatSync(globalPackageDir);
        if (!existingPackage.isSymbolicLink()) {
            console.log(`[jaw:link] chmod ok; skip linking because ${globalPackageDir} is a real install, not a symlink`);
            return;
        }
    } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }

    fs.mkdirSync(path.dirname(globalPackageDir), { recursive: true });
    fs.mkdirSync(nodeBinDir, { recursive: true });

    const packageChanged = ensureSymlink(globalPackageDir, repoRoot, 'dir');
    const binChanges = BIN_NAMES.map(name => {
        const linkPath = path.join(nodeBinDir, name);
        return ensureSymlink(linkPath, packageBin, 'file') ? name : null;
    }).filter(Boolean);

    const changed = [
        packageChanged ? PACKAGE_NAME : null,
        ...binChanges,
    ].filter(Boolean);
    const status = changed.length > 0 ? `updated ${changed.join(', ')}` : 'already linked';
    console.log(`[jaw:link] ${status} -> ${nodeBinDir}`);
}

try {
    main();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jaw:link] failed: ${message}`);
    process.exit(1);
}
