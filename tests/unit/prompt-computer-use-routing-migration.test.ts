import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { PROMPTS_DIR } from '../../src/core/config.ts';
import { getSystemPrompt, initPromptFiles } from '../../src/prompt/builder.ts';

const a1 = join(PROMPTS_DIR, 'A-1.md');
const hash = a1 + '.hash';
const oldLine = '5. **`$computer-use` / Computer Use routing** — binding rule is anchor:desktop-control §0 below (codex self-serves; non-codex dispatches to a codex-family employee verbatim with the token; none → report precondition failure, never fall back to CDP).';
const editedLine = '5. **`$computer-use` / Computer Use routing** — my custom routing';
const currentLine = fs.readFileSync(join(process.cwd(), 'src/prompt/templates/a1-system.md'), 'utf8')
    .split('\n').find(line => line.startsWith('5. **`$computer-use` / Computer Use routing**'))!;

test('rendered Claude boss prompt routes Computer Use through jaw-computer-use', () => {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    fs.rmSync(a1, { force: true });
    fs.rmSync(hash, { force: true });
    initPromptFiles();
    const prompt = getSystemPrompt({ activeCli: 'claude', currentPrompt: '$computer-use' });
    assert.match(prompt, /jaw-computer-use/);
    assert.doesNotMatch(prompt, /dispatch --agent "Control"/);
});

for (const hashPresent of [true, false]) {
    test(`custom A-1 ${hashPresent ? 'with hash' : 'before hashes'} migrates exactly one stock routing line`, () => {
        fs.mkdirSync(PROMPTS_DIR, { recursive: true });
        const original = `# user edits\n${oldLine}\n## mine\n`;
        fs.writeFileSync(a1, original);
        if (hashPresent) fs.writeFileSync(hash, 'previous-template-hash');
        else fs.rmSync(hash, { force: true });
        initPromptFiles();
        const persisted = fs.readFileSync(a1, 'utf8');
        assert.ok(persisted.includes(currentLine));
        assert.equal(persisted.includes(oldLine), false);
        assert.ok(persisted.startsWith('# user edits\n'));
        assert.ok(persisted.includes('## mine\n'));
        assert.ok(fs.existsSync(hash));
    });

    test(`custom A-1 ${hashPresent ? 'with hash' : 'before hashes'} preserves edited and duplicated routing lines`, () => {
        for (const line of [editedLine, `${oldLine}\n${oldLine}`]) {
            fs.mkdirSync(PROMPTS_DIR, { recursive: true });
            fs.writeFileSync(a1, `# user edits\n${line}\n`);
            if (hashPresent) fs.writeFileSync(hash, 'previous-template-hash');
            else fs.rmSync(hash, { force: true });
            initPromptFiles();
            const persisted = fs.readFileSync(a1, 'utf8');
            assert.ok(persisted.startsWith(`# user edits\n${line}\n`));
            assert.equal(persisted.includes(currentLine), false);
        }
    });
}
