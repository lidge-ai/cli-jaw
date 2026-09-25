import test from 'node:test';
import assert from 'node:assert/strict';
import { createResizeGuard, RESIZE_GUARD_SETTLE_MS } from '../../public/js/features/resize-guard.js';

test('resize guard toggles once per resize burst and settles after quiet', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events: string[] = [];
    const notify = createResizeGuard({
        onResizeStart: () => events.push('start'),
        onResizeEnd: () => events.push('end'),
    });

    notify();
    notify();
    t.mock.timers.tick(RESIZE_GUARD_SETTLE_MS - 1);
    notify();
    assert.deepEqual(events, ['start']);

    t.mock.timers.tick(RESIZE_GUARD_SETTLE_MS);
    assert.deepEqual(events, ['start', 'end']);
});

test('resize guard re-arms for the next burst', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events: string[] = [];
    const notify = createResizeGuard({
        onResizeStart: () => events.push('start'),
        onResizeEnd: () => events.push('end'),
        settleMs: 50,
    });

    notify();
    t.mock.timers.tick(60);
    notify();
    t.mock.timers.tick(60);
    assert.deepEqual(events, ['start', 'end', 'start', 'end']);
});
