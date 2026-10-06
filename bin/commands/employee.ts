/**
 * cli-jaw employee — employee utilities
 * Usage:
 *   cli-jaw employee list [--port 3457] [--json]
 *   cli-jaw employee reset [--port 3457]
 *   cli-jaw employee sessions-reset [--port 3457]
 */
import { parseArgs } from 'node:util';
import { getServerUrl } from '../../src/core/config.js';
import { stripUndefined } from '../../src/core/strip-undefined.js';
import { getCliAuthToken } from '../../src/cli/api-auth.js';
import { asArray, asRecord, fieldString, type JsonRecord } from '../_http-client.js';

const sub = String(process.argv[3] || '').toLowerCase();
const isHelpSubcommand = sub === '--help' || sub === '-h' || sub === 'help';
const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
        port: { type: 'string', default: process.env["PORT"] || '3457' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
    },
    strict: false,
});

function printHelp() {
    console.log(`
  Usage:
    cli-jaw employee list [--port 3457] [--json]
    cli-jaw employee reset [--port 3457]
    cli-jaw employee sessions-reset [--port 3457]

  Description:
    List employees or reset DB employees to built-in defaults.
    sessions-reset clears only persisted employee resume sessions.
    Static employees, when configured, are merged into the list by the server.
`);
}

interface EmployeeListRow {
    id: string;
    name: string;
    cli: string;
    model: string | undefined;
    role: string | undefined;
    source: string | undefined;
}

type EmployeeApiInit = Omit<RequestInit, 'body' | 'headers'> & {
    body?: unknown;
    headers?: Record<string, string>;
};

async function apiJson<T = JsonRecord>(baseUrl: string, path: string, init: EmployeeApiInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.headers || {}) };
    let body: string | undefined;
    if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    }
    if (init.body !== undefined && typeof init.body !== 'string') {
        headers['Content-Type'] = 'application/json';
    }
    const { body: _body, headers: _headers, ...rest } = init;
    const { authHeaders } = await import('../../src/cli/api-auth.js');
    const mergedHeaders = { ...authHeaders(), ...headers };
    const res = await fetch(baseUrl + path, stripUndefined({ ...rest, headers: mergedHeaders, body, signal: AbortSignal.timeout(10000) }));
    const text = await res.text();
    let data: JsonRecord = {};
    try { data = text ? asRecord(JSON.parse(text)) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(fieldString(data["error"]) || `HTTP ${res.status}`);
    return data as T;
}

function employeeListRows(payload: unknown): EmployeeListRow[] {
    const record = asRecord(payload);
    const rawRows = Array.isArray(payload) ? payload : record["data"];
    return asArray<JsonRecord>(rawRows).map(row => ({
        id: fieldString(row["id"]),
        name: fieldString(row["name"]),
        cli: fieldString(row["cli"]),
        model: fieldString(row["model"]) || undefined,
        role: fieldString(row["role"]) || undefined,
        source: fieldString(row["source"]) || undefined,
    }));
}

function printEmployeeList(rows: EmployeeListRow[]): void {
    if (rows.length === 0) {
        console.log('(no employees configured)');
        return;
    }
    const headers = ['Name', 'ID', 'CLI', 'Model', 'Role', 'Source'];
    const data = rows.map(row => [
        row.name,
        row.id,
        row.cli,
        row.model || '',
        row.role || '',
        row.source || '',
    ]);
    const widths = headers.map((header, index) => Math.max(
        header.length,
        ...data.map(row => row[index]?.length || 0),
    ));
    console.log(headers.map((header, index) => header.padEnd(widths[index]!)).join('  '));
    console.log(widths.map(width => '-'.repeat(width)).join('  '));
    for (const row of data) {
        console.log(row.map((value, index) => value.padEnd(widths[index]!)).join('  '));
    }
}

if (values.help || !sub || isHelpSubcommand) {
    printHelp();
    process.exit(0);
}

const baseUrl = getServerUrl(values.port as string);
await getCliAuthToken(values.port as string);

switch (sub) {
    case 'list': {
        try {
            const payload = await apiJson<unknown>(baseUrl, '/api/employees');
            const rows = employeeListRows(payload);
            if (values.json) {
                console.log(JSON.stringify(rows, null, 2));
            } else {
                printEmployeeList(rows);
            }
        } catch (err) {
            console.error(`❌ employee list failed: ${(err as Error).message}`);
            process.exitCode = 1;
        }
        break;
    }
    case 'reset': {
        try {
            const result = await apiJson<{ seeded?: number }>(baseUrl, '/api/employees/reset', { method: 'POST' });
            console.log(`✅ employees reset complete (${result.seeded ?? 0} seeded)`);
        } catch (err) {
            console.error(`❌ employee reset failed: ${(err as Error).message}`);
            process.exitCode = 1;
        }
        break;
    }
    case 'sessions-reset':
    case 'session-reset':
    case 'reset-sessions': {
        try {
            const result = await apiJson<{ cleared?: number }>(baseUrl, '/api/employees/sessions/reset', { method: 'POST' });
            console.log(`✅ employee sessions reset complete (${result.cleared ?? 0} cleared)`);
        } catch (err) {
            console.error(`❌ employee sessions reset failed: ${(err as Error).message}`);
            process.exitCode = 1;
        }
        break;
    }
    default:
        console.error(`❌ Unknown employee subcommand: ${sub}`);
        printHelp();
        process.exitCode = 1;
        break;
}
