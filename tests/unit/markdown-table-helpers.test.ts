import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import {
    CSV_BOM, TABLE_CSV_FILENAME, escapeMarkdownTableCell, guardSpreadsheetFormula,
    findLinkLabelEnd, inlineLinkMarkdown, isTableModel, normalizeTableModel, tableFingerprint, tableToCsv,
    tableToMarkdown, type TableModel,
} from '../../src/shared/markdown-table.js';
import {
    EXPECTED_REFERENCE_MARKDOWN, EXPECTED_REFERENCE_MODEL, EXPECTED_TABLE1_CSV,
    EXPECTED_TABLE1_MARKDOWN, EXPECTED_TABLE1_MODEL, EXPECTED_TABLE2_CSV,
    EXPECTED_TABLE2_MARKDOWN, EXPECTED_TABLE2_MODEL,
} from '../fixtures/markdown-table-fixture.js';

const cell = (text: string, markdown = text) => ({ text, markdown });

test('escapes pipes according to backslash parity and normalizes newlines', () => {
    assert.equal(escapeMarkdownTableCell('a|b'), 'a\\|b');
    assert.equal(escapeMarkdownTableCell('a\\|b'), 'a\\|b');
    assert.equal(escapeMarkdownTableCell('`a|b`'), '`a\\|b`');
    assert.equal(escapeMarkdownTableCell('a\\\\|b'), 'a\\\\\\|b');
    assert.equal(escapeMarkdownTableCell('a\r\nb\rc\nd'), 'a<br>b<br>c<br>d');
});

test('normalizes ragged rows and renders alignment and empty cells', () => {
    const m: TableModel = { align: ['left', 'center', 'right', null, 'left'], header: [cell('a'), cell('b'), cell('c'), cell('d')], rows: [[cell('x')], [cell('1'), cell('2'), cell('3'), cell('4'), cell('ignored')]] };
    assert.deepEqual(normalizeTableModel(m).rows[0], [cell('x'), cell(''), cell(''), cell('')]);
    assert.equal(tableToMarkdown(m), '| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| x |  |  |  |\n| 1 | 2 | 3 | 4 |');
    assert.deepEqual(normalizeTableModel({ align: [], header: [cell('a')], rows: [] }).align, [null]);
});

test('guards formulas but exempts strict numeric literals', () => {
    for (const v of ['=1+1', '+A1', '-1+2', '@SUM', ' =1', '\t=1', '\r=1']) assert.equal(guardSpreadsheetFormula(v), "'" + v);
    for (const v of ['-12.5', '+82', '1,234.5', '50%', 'plain text']) assert.equal(guardSpreadsheetFormula(v), v);
});

test('CSV quotes RFC 4180 fields and uses CRLF without BOM', () => {
    const m: TableModel = { align: [], header: [cell('한글'), cell('comma'), cell('quote'), cell('newline'), cell('space')], rows: [[cell('값'), cell('a,b'), cell('a"b'), cell('a\nb'), cell(' x ')]] };
    assert.equal(tableToCsv(m), '한글,comma,quote,newline,space\r\n값,"a,b","a""b","a\nb"," x "');
    assert.equal(CSV_BOM, '\uFEFF');
    assert.equal(TABLE_CSV_FILENAME, 'table.csv');
});

test('validates table model shapes', () => {
    assert.equal(isTableModel(EXPECTED_TABLE1_MODEL), true);
    for (const v of [null, {}, { align: ['bad'], header: [], rows: [] }, { align: [], header: [{ text: 'x' }], rows: [] }, { align: [], header: [], rows: [[{ text: 1, markdown: '' }]] }, { align: [], header: [], rows: [null] }]) assert.equal(isTableModel(v), false);
});

test('fixture conversions agree with hand-written expectations', () => {
    assert.equal(tableToMarkdown(EXPECTED_TABLE1_MODEL), EXPECTED_TABLE1_MARKDOWN);
    assert.equal(tableToCsv(EXPECTED_TABLE1_MODEL), EXPECTED_TABLE1_CSV);
    assert.equal(tableToMarkdown(EXPECTED_TABLE2_MODEL), EXPECTED_TABLE2_MARKDOWN);
    assert.equal(tableToCsv(EXPECTED_TABLE2_MODEL), EXPECTED_TABLE2_CSV);
    assert.equal(tableToMarkdown(EXPECTED_REFERENCE_MODEL), EXPECTED_REFERENCE_MARKDOWN);
});

test('inlines reference links with destinations and titles', () => {
    assert.equal(inlineLinkMarkdown('Kim', 'https://example.com/kim', 'Kim page'), '[Kim](https://example.com/kim "Kim page")');
    assert.equal(inlineLinkMarkdown('x', 'https://example.com/a(b)'), '[x](<https://example.com/a(b)>)');
    assert.equal(inlineLinkMarkdown('x', 'https://example.com/a b', 'a "title"'), '[x](<https://example.com/a b> "a \\"title\\"")');
});

test('inline destinations and titles round-trip through marked', () => {
    assert.equal(inlineLinkMarkdown('x', 'https://example.com/path', 'trailing\\'), String.raw`[x](https://example.com/path "trailing\\")`);
    assert.equal(inlineLinkMarkdown('x', 'https://example.com/a>(b)'), String.raw`[x](<https://example.com/a\>(b)>)`);
    assert.equal(inlineLinkMarkdown('x', ''), '[x](<>)');
    const cases = [
        { url: 'https://example.com/path', title: 'trailing\\' },
        { url: 'https://example.com/path', title: 'a "quoted" title' },
        { url: 'https://example.com/a>(b)', title: 'angle and parens' },
        { url: 'https://example.com/a b', title: 'space' },
        { url: 'https://e.com/a\\*b', title: 'backslash punctuation' },
        { url: '', title: 'empty destination' },
        { url: 'https://example.com/<a\\b>', title: 'slash \\ and "quote"' },
    ];
    for (const { url, title } of cases) {
        const markdown = inlineLinkMarkdown('x', url, title);
        const paragraph = marked.lexer(markdown)[0];
        assert.equal(paragraph?.type, 'paragraph', markdown);
        if (paragraph?.type !== 'paragraph') continue;
        const link = paragraph.tokens[0];
        assert.equal(link?.type, 'link', markdown);
        if (link?.type !== 'link') continue;
        assert.equal(link.href, url, markdown);
        assert.equal(link.title, title, markdown);
    }
});

test('finds label ends with nested and escaped brackets', () => {
    const nested = '![A [nested] B][id]';
    const escaped = String.raw`![A \] B][id]`;
    const escapedOpen = String.raw`![A \[ B][id]`;
    const evenSlashes = String.raw`![A \\[nested] B][id]`;
    const unclosed = '![A [nested] B';
    for (const raw of [nested, escaped, escapedOpen, evenSlashes]) {
        assert.equal(findLinkLabelEnd(raw, 2), raw.indexOf('][id]'));
    }
    assert.equal(findLinkLabelEnd(unclosed, 2), unclosed.length);
});

test('fingerprints are stable and change with the rendered table', () => {
    assert.match(tableFingerprint(EXPECTED_TABLE1_MODEL), /^[0-9a-f]{8}$/);
    assert.equal(tableFingerprint(EXPECTED_TABLE1_MODEL), tableFingerprint(structuredClone(EXPECTED_TABLE1_MODEL)));
    const changed = structuredClone(EXPECTED_TABLE1_MODEL);
    changed.rows[0]![0]!.markdown = '인천';
    assert.notEqual(tableFingerprint(EXPECTED_TABLE1_MODEL), tableFingerprint(changed));
});
