import type { SettingsClient } from './types';

const TIMEOUT_MS = 8000;

export class SettingsRequestError extends Error {
    method: string;
    path: string;
    status: number;
    detail: string;
    constructor(method: string, path: string, status: number, detail: string) {
        super(`${method} ${path} → ${status}: ${detail}`);
        this.name = 'SettingsRequestError';
        this.method = method;
        this.path = path;
        this.status = status;
        this.detail = detail;
    }
}

export function buildBaseUrl(port: number): string {
    return `/i/${port}`;
}

export function createSettingsClient(port: number, options: {
    base?: string; getHeaders?: () => Promise<Record<string, string>>;
} = {}): SettingsClient {
    const base = options.base ?? buildBaseUrl(port);
    const url = (path: string): string => `${base}${path}`;
    const headers: HeadersInit = { 'content-type': 'application/json' };

    async function request<T>(
        method: string,
        path: string,
        body?: unknown,
        init?: RequestInit,
    ): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const requestHeaders = new Headers(headers);
            for (const [key, value] of Object.entries(await options.getHeaders?.() ?? {})) requestHeaders.set(key, value);
            new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
            const fetchInit: RequestInit = {
                ...init, method, headers: requestHeaders,
                signal: init?.signal || controller.signal,
            };
            if (body !== undefined) fetchInit.body = JSON.stringify(body);
            const response = await fetch(url(path), fetchInit);
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new SettingsRequestError(method, path, response.status, detail);
            }
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                return (await response.json()) as T;
            }
            const detail = await response.text().catch(() => '');
            throw new SettingsRequestError(
                method,
                path,
                response.status,
                `expected JSON, received ${ct || 'unknown content-type'}: ${detail.slice(0, 120)}`,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        url,
        get: (path, init) => request('GET', path, undefined, init),
        put: (path, body, init) => request('PUT', path, body, init),
        post: (path, body, init) => request('POST', path, body, init),
        delete: (path, init) => request('DELETE', path, undefined, init),
    };
}
