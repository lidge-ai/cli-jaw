import type { TableModel } from '../../src/shared/markdown-table.js';

export const EDGE_FIXTURE_MARKDOWN = String.raw`| Edge |
| --- |
| ![A \] B][id] |
| ![A [nested] B][id] |
| ![A &amp; B](https://example.com/i.png) |
| ${'`'}A &amp; B${'`'} |

[id]: https://example.com/img`;

export const EXPECTED_EDGE_MODEL: TableModel = {
    align: [null], header: [{ text: 'Edge', markdown: 'Edge' }],
    rows: [
        [{ text: 'A ] B', markdown: String.raw`![A \] B](https://example.com/img)` }],
        [{ text: 'A [nested] B', markdown: '![A [nested] B](https://example.com/img)' }],
        [{ text: 'A & B', markdown: '![A &amp; B](https://example.com/i.png)' }],
        [{ text: 'A &amp; B', markdown: '`A &amp; B`' }],
    ],
};

export const TABLE_FIXTURE_MARKDOWN = String.raw`| 도시 | 담당자 | 값 | 메모 |
| :-- | :-: | --: | --- |
| 서울 | [Kim][k] | =SUM(A1:A2) | line one<br>line two |
| 제주 | Lee \| Park | +82 | |
| 대구 | @mention | -12.5 | "quoted", with comma |
| 광주 | 직원 | 42 | 완료 |
| 부산 | A &amp; B | 1,234.5 | 50% |

| 항목 | 값 |
| --- | --- |
| 하나 | 둘 |

[k]: https://example.com/kim "Kim page"`;

export const REFERENCE_FIXTURE_MARKDOWN = String.raw`| Reference |
| --- |
| [a][x)] |
| [Kim][k] |
| **[Kim][k]** |
| [k][] |
| [k] |

[x)]: https://example.com/a
[k]: https://example.com/kim "Kim page"`;

export const EXPECTED_TABLE1_MODEL: TableModel = {
    align: ['left', 'center', 'right', null],
    header: [
        { text: '도시', markdown: '도시' }, { text: '담당자', markdown: '담당자' },
        { text: '값', markdown: '값' }, { text: '메모', markdown: '메모' },
    ],
    rows: [
        [{ text: '서울', markdown: '서울' }, { text: 'Kim', markdown: '[Kim](https://example.com/kim "Kim page")' }, { text: '=SUM(A1:A2)', markdown: '=SUM(A1:A2)' }, { text: 'line one\nline two', markdown: 'line one<br>line two' }],
        [{ text: '제주', markdown: '제주' }, { text: 'Lee | Park', markdown: 'Lee \\| Park' }, { text: '+82', markdown: '+82' }, { text: '', markdown: '' }],
        [{ text: '대구', markdown: '대구' }, { text: '@mention', markdown: '@mention' }, { text: '-12.5', markdown: '-12.5' }, { text: '"quoted", with comma', markdown: '"quoted", with comma' }],
        [{ text: '광주', markdown: '광주' }, { text: '직원', markdown: '직원' }, { text: '42', markdown: '42' }, { text: '완료', markdown: '완료' }],
        [{ text: '부산', markdown: '부산' }, { text: 'A & B', markdown: 'A &amp; B' }, { text: '1,234.5', markdown: '1,234.5' }, { text: '50%', markdown: '50%' }],
    ],
};
export const EXPECTED_TABLE2_MODEL: TableModel = {
    align: [null, null],
    header: [{ text: '항목', markdown: '항목' }, { text: '값', markdown: '값' }],
    rows: [[{ text: '하나', markdown: '하나' }, { text: '둘', markdown: '둘' }]],
};
export const EXPECTED_REFERENCE_MODEL: TableModel = {
    align: [null], header: [{ text: 'Reference', markdown: 'Reference' }],
    rows: [
        [{ text: 'a', markdown: '[a](https://example.com/a)' }],
        [{ text: 'Kim', markdown: '[Kim](https://example.com/kim "Kim page")' }],
        [{ text: 'Kim', markdown: '**[Kim](https://example.com/kim "Kim page")**' }],
        [{ text: 'k', markdown: '[k](https://example.com/kim "Kim page")' }],
        [{ text: 'k', markdown: '[k](https://example.com/kim "Kim page")' }],
    ],
};
export const EXPECTED_TABLE1_MARKDOWN = String.raw`| 도시 | 담당자 | 값 | 메모 |
| :--- | :---: | ---: | --- |
| 서울 | [Kim](https://example.com/kim "Kim page") | =SUM(A1:A2) | line one<br>line two |
| 제주 | Lee \| Park | +82 |  |
| 대구 | @mention | -12.5 | "quoted", with comma |
| 광주 | 직원 | 42 | 완료 |
| 부산 | A &amp; B | 1,234.5 | 50% |`;
export const EXPECTED_TABLE1_CSV = '도시,담당자,값,메모\r\n서울,Kim,\'=SUM(A1:A2),"line one\nline two"\r\n제주,Lee | Park,+82,\r\n대구,\'@mention,-12.5,"""quoted"", with comma"\r\n광주,직원,42,완료\r\n부산,A & B,"1,234.5",50%';
export const EXPECTED_TABLE2_MARKDOWN = '| 항목 | 값 |\n| --- | --- |\n| 하나 | 둘 |';
export const EXPECTED_TABLE2_CSV = '항목,값\r\n하나,둘';
export const EXPECTED_REFERENCE_MARKDOWN = `| Reference |
| --- |
| [a](https://example.com/a) |
| [Kim](https://example.com/kim "Kim page") |
| **[Kim](https://example.com/kim "Kim page")** |
| [k](https://example.com/kim "Kim page") |
| [k](https://example.com/kim "Kim page") |`;
