import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAddressBarState,
    displayedAddress,
    reduceAddressBar,
    shouldShowRecentVisits,
} from '../../public/manager/src/browser-panel/browser-address-state.js';

test('unfocused displayed address is the live URL', () => {
    const state = createAddressBarState('https://example.com/');
    assert.equal(state.focused, false);
    assert.equal(displayedAddress(state), 'https://example.com/');
});

test('focus copies live URL into draft', () => {
    const started = createAddressBarState('https://example.com/');
    const focused = reduceAddressBar(started, { type: 'focus' });
    assert.equal(focused.focused, true);
    assert.equal(focused.draft, 'https://example.com/');
    assert.equal(displayedAddress(focused), 'https://example.com/');
});

test('sync-live while focused preserves draft', () => {
    const focused = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: 'search terms' },
    );
    const synced = reduceAddressBar(focused, { type: 'sync-live', liveUrl: 'https://redirect.example/' });
    assert.equal(synced.focused, true);
    assert.equal(synced.draft, 'search terms');
    assert.equal(synced.liveUrl, 'https://redirect.example/');
    assert.equal(displayedAddress(synced), 'search terms');
});

test('sync-live while unfocused updates draft and live URL', () => {
    const synced = reduceAddressBar(
        createAddressBarState('https://example.com/'),
        { type: 'sync-live', liveUrl: 'https://next.example/' },
    );
    assert.equal(synced.focused, false);
    assert.equal(synced.draft, 'https://next.example/');
    assert.equal(synced.liveUrl, 'https://next.example/');
    assert.equal(displayedAddress(synced), 'https://next.example/');
});

test('escape reverts draft to live and unfocuses', () => {
    const edited = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: 'partial' },
    );
    const escaped = reduceAddressBar(edited, { type: 'escape' });
    assert.equal(escaped.focused, false);
    assert.equal(escaped.draft, 'https://example.com/');
    assert.equal(escaped.liveUrl, 'https://example.com/');
    assert.equal(displayedAddress(escaped), 'https://example.com/');
});

test('submit unfocuses and keeps the submitted draft as live', () => {
    const edited = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: 'https://next.example/' },
    );
    const submitted = reduceAddressBar(edited, { type: 'submit' });
    assert.equal(submitted.focused, false);
    assert.equal(submitted.draft, 'https://next.example/');
    assert.equal(submitted.liveUrl, 'https://next.example/');
    assert.equal(displayedAddress(submitted), 'https://next.example/');
});

test('empty draft displays as an empty string while focused', () => {
    const emptied = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: '' },
    );
    assert.equal(displayedAddress(emptied), '');
});

test('blur keeps draft without reverting to live', () => {
    const edited = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: 'kept draft' },
    );
    const blurred = reduceAddressBar(edited, { type: 'blur' });
    assert.equal(blurred.focused, false);
    assert.equal(blurred.draft, 'kept draft');
    assert.equal(blurred.liveUrl, 'https://example.com/');
    assert.equal(displayedAddress(blurred), 'https://example.com/');
});

test('recents show while the focused draft is still the live URL', () => {
    const focused = reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' });
    assert.equal(focused.draft, focused.liveUrl);
    assert.equal(shouldShowRecentVisits(focused), true);
});

test('recents show while the user has cleared the focused draft', () => {
    const emptied = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: '   ' },
    );
    assert.equal(shouldShowRecentVisits(emptied), true);
});

test('a typed query hides recents', () => {
    const typed = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: 'docs' },
    );
    assert.equal(shouldShowRecentVisits(typed), false);
});

test('recents never cover the page while the address bar is unfocused', () => {
    assert.equal(shouldShowRecentVisits(createAddressBarState('https://example.com/')), false);
    const cleared = reduceAddressBar(
        reduceAddressBar(createAddressBarState('https://example.com/'), { type: 'focus' }),
        { type: 'change', draft: '' },
    );
    assert.equal(shouldShowRecentVisits(cleared), true);
    assert.equal(shouldShowRecentVisits(reduceAddressBar(cleared, { type: 'blur' })), false);
    assert.equal(
        shouldShowRecentVisits(reduceAddressBar(cleared, { type: 'submit' })),
        false,
        'a submitted address leaves the page visible',
    );
});
