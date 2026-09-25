// ── CLI-JAW Service Worker ──
// Three-tier fetch: navigate→network-first, hashed→cache-first, static→stale-while-revalidate

const CACHE_NAME = 'clijaw-v3-dev-20260925-mascot';
const STATIC_ASSETS = [
    // Only pre-cache immutable/semi-static assets — NOT '/' (HTML is dynamic)
    '/css/variables.css',
    '/css/layout.css',
    '/css/chat.css',
    '/css/sidebar.css',
    '/css/modals.css',
    '/css/markdown.css',
    '/css/orc-state.css',
    '/css/tool-ui.css',
    '/manifest.json',
];

// Install: pre-cache static assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate: purge old caches, claim clients
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Fetch: three-tier strategy
self.addEventListener('fetch', (e) => {
    const { request } = e;
    const url = new URL(request.url);

    // Only handle GET requests from same origin
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    // API, WebSocket, Vite HMR, and SW itself → network only (no intercept)
    if (url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/ws') ||
        url.pathname.startsWith('/@vite') ||
        url.pathname.startsWith('/__vite') ||
        url.pathname === '/sw.js') {
        return;
    }

    // Tier 1: Navigation → network-first with cache fallback (any cached page, prefer '/')
    if (request.mode === 'navigate') {
        e.respondWith(
            fetch(request).then(resp => {
                if (resp.ok && resp.type === 'basic') {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
                }
                return resp;
            }).catch(() =>
                caches.match(request)
                    .then(c => c || caches.match('/'))
                    .then(c => c || new Response('Offline', { status: 503 }))
            )
        );
        return;
    }

    // Tier 2: Hashed assets (/dist/assets/*) → cache-first (immutable by content hash)
    if (url.pathname.startsWith('/dist/assets/')) {
        e.respondWith(
            caches.match(request).then(cached => {
                if (cached) return cached;
                return fetch(request).then(resp => {
                    if (resp.ok && resp.type === 'basic') {
                        const clone = resp.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
                    }
                    return resp;
                }).catch(() => new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
            })
        );
        return;
    }

    // Tier 3: Everything else (CSS, manifest, etc.) → stale-while-revalidate
    e.respondWith(
        caches.open(CACHE_NAME).then(cache =>
            cache.match(request).then(cached => {
                const networkFetch = fetch(request).then(resp => {
                    if (resp.ok && resp.type === 'basic') {
                        cache.put(request, resp.clone()).catch(() => {});
                    }
                    return resp;
                }).catch(() => null);
                return cached || networkFetch.then(r =>
                    r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
                );
            })
        )
    );
});
