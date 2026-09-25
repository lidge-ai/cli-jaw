import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const values = (css: string) => [...css.matchAll(/--workspace-topbar-height:\s*([^;]+);/g)].map(match => match[1]!.trim());

test('manager and instance pages share the same top bar height token values', () => {
    const manager = values(read('public/manager/src/manager-tokens.css'));
    const instance = values(read('public/css/variables.css'));
    assert.deepEqual(manager, ['44px', '52px']);
    assert.deepEqual(instance, manager);
});

test('workbench header is fixed to the shared top bar height', () => {
    const css = read('public/manager/src/manager-components.css');
    const block = css.slice(css.indexOf('.workbench-header {'), css.indexOf('}', css.indexOf('.workbench-header {')));
    assert.match(block, /\n\s*height: var\(--workspace-topbar-height\);/);
    assert.doesNotMatch(block, /min-height/);
});
