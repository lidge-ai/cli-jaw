import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Keeps the four READMEs structurally in step with the English source of truth.
// Prose is translated freely; images, download links, install commands, section
// count and the generated Windows block are shared facts.
const root = join(import.meta.dirname, '..', '..');
const FILES = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md'];
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const readmes = Object.fromEntries(FILES.map(file => [file, read(file)])) as Record<string, string>;

const stripCode = (src: string) => src.replace(/```[\s\S]*?```/g, '');
const h2Count = (src: string) => stripCode(src).split('\n').filter(line => /^## /.test(line)).length;
const imagePaths = (src: string) => [...src.matchAll(/<img[^>]+src="([^"]+)"|!\[[^\]]*\]\(([^)]+)\)/g)]
    .map(match => match[1] ?? match[2])
    .filter(path => !/^https?:\/\/img\.shields\.io\//.test(path))
    .sort();

const RELEASES_LATEST = 'https://github.com/lidge-jun/cli-jaw/releases/latest';

for (const file of FILES) {
    test(`RP-001 ${file}: banner, download badges and two-line install`, () => {
        const src = readmes[file];
        assert.ok(src.includes('docs/assets/readme/banner.jpg'), 'banner image');
        for (const badge of ['Download for macOS (.dmg)', 'Download for Windows (.exe)', 'Download for Linux (.AppImage)']) {
            assert.ok(src.includes(badge), `missing ${badge}`);
        }
        assert.ok(src.split(RELEASES_LATEST).length - 1 >= 3, 'download badges link the latest release');
        assert.ok(src.includes('npm install -g cli-jaw\njaw dashboard'), 'two-line install');
    });

    test(`RP-002 ${file}: no retired JWC integration copy`, () => {
        assert.doesNotMatch(readmes[file], /retired jwc|jawcode|jaw jwc/i);
    });

    test(`RP-003 ${file}: generated Windows block markers present once`, () => {
        const src = readmes[file];
        assert.equal(src.split('<!-- windows-support:start').length - 1, 1);
        assert.equal(src.split('<!-- windows-support:end -->').length - 1, 1);
    });
}

test('RP-004 localized READMEs keep the English section count and images', () => {
    const english = readmes['README.md'];
    for (const file of FILES.slice(1)) {
        assert.equal(h2Count(readmes[file]), h2Count(english), `${file} H2 count`);
        assert.deepEqual(imagePaths(readmes[file]), imagePaths(english), `${file} image paths`);
    }
});

