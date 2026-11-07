# tests/helpers

Machinery that tests drive, not tests themselves. Nothing here is collected by
`tests/run.mts`: the driver only picks up `*.test.ts` under a declared scope
(`tests/run.mts` `list()`, `tests/setup/shard.ts` `SCOPES`), and this directory is
not a scope. Files here are imported or spawned by a test that is.

## What lives here

| File | Shape | Driven by |
| --- | --- | --- |
| `jaw-server.mts` | Spawns an isolated product server with its own home, settings and port; probes readiness, captures the child's output, and fails closed under `CI` | `tests/integration/slack-inbound-turn.test.ts`, `agent-lifecycle-real-child.test.ts`, `graceful-shutdown.test.ts` |
| `slack-fetch.mts` | The one Slack fetch stub: sequential or method-keyed response queues, parsed request bodies, and specs for a Slack error, a 429 with `retry-after`, or a transport-level response with an empty body | the six `tests/unit/slack-*.test.ts` files and `slack-fetch-harness.test.ts` |
| `with-server.mts` | The one listen/close owner for route tests: `listen(0, '127.0.0.1')` behind an error listener, then `closeAllConnections()` before `close()`, then an optional after-hook | the sixteen `tests/unit` route suites that used to hand-roll `withServer` |
| `slack-fixture.mts` | A scripted Slack: Web API over HTTP plus Socket Mode over a real websocket, recording every call | `tests/integration/slack-inbound-turn.test.ts` |
| `slack-api-preload.mjs` | `--import` preload that redirects a server child's Slack traffic at the fixture through `globalThis.fetch` | the same test, via `NODE_OPTIONS` |
| `code-fake-providers.mts` | Injectable Code providers that never spawn a runtime, with per-instance open/send counters | `tests/integration/code-native-api.test.ts` |
| `code-host-child.mts` | A child Code host that can crash itself mid-turn, so recovery has a real orphan to seal | `tests/integration/code-native-api.test.ts` |
| `skip-policy.mts` | The registry of every test file that skips, with a reason and a CI policy, plus the detector both it and its test use | `tests/integration/skip-policy.test.ts` |
| `code-native-qa-server.mjs` | Supervises a built Manager with mocked Code providers and read-only standalone settings/Preview workers, plus a `/__qa` control surface | `tests/browser/code-native-workbench.test.ts`, `tests/browser/retired-runtime-settings.test.ts`, `tests/browser/manager-layout-smoke.test.ts` |
| `hosted-manager-qa.mjs` | Hosted Manager + Playwright QA driver | the `workflow_dispatch`-only Hosted Manager QA job |

The last two need a build and a browser, which is why they sit outside the
PR-admission path. A helper that an `integration` test depends on must not: that
job runs on every code PR and feeds `ci-aggregate`.

## Rules for a new helper

**Fail closed, or do not guard at all.** The pattern to copy is
`tests/integration/api-smoke.test.ts`: a missing dependency is a skip on a
developer box and an `assert.fail` under `CI`, because the integration job owns
that dependency and a silent skip there turns a broken startup into a green run.
A helper that returns a `'skipped'` sentinel pushes that decision onto every
caller, and the callers have historically got it wrong.

**Surface the child's output.** A helper that spawns a process captures stdout
and stderr and attaches them to the error it throws. A boot failure with no
output reads as an environment quirk, which is how one gets skipped instead of
fixed.

**Bound every wait below the driver's watchdog.** `tests/run.mts` fails a file
that goes quiet for `JAW_TEST_FILE_STALL_MS` (default 180s). Any hold, poll or
retry a helper owns needs a cap well under that, so a missed release fails one
case with a usable message instead of stalling the job and being attributed to
the runner.

**Name the seam in a comment.** Several product paths have exactly one test
seam and no second one — a constructor argument that production never passes, a
global that is resolved at call time, a binary resolved off `PATH`. When a
helper depends on one, say which line of the product makes it work, so the next
person who changes that line finds out here rather than in a red CI run.

## Scope note

Helpers are test infrastructure. They may import product modules read-only to
reuse a contract (path resolution, wire types) but must not require a change to
`src/`, `server.ts` or `bin/` to function. If a crossing cannot be tested
without a new product seam, that is a finding to report, not something to work
around here.
