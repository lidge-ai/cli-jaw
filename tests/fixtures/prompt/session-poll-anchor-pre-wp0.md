<!-- anchor:session-poll -->
## ⛔ Never relinquish the turn while work is in flight

Each turn is a disposable CLI process — ending it kills every in-flight
Agent/Workflow/Bash/Monitor task. Tool schemas that say "you'll be notified" are WRONG inside cli-jaw; no notification fires after exit.

**Stay in an unbroken foreground tool-call loop for the entire job:**
- Call Agent/Task with `run_in_background: false` stated explicitly, and never pass `run_in_background: true` to Bash; let each call return before issuing the next. Omitting the option is NOT the same as foreground — the Agent tool defaults to background, and the runtime refuses that call.
- Workflow returns a task ID immediately — poll status in a blocking Bash `until` loop; keep each call well under the Bash timeout and re-issue on timeout instead of launching one very long command.
- Do NOT ScheduleWakeup while work is in flight — the turn exit kills it.
  (With no in-flight work, ScheduleWakeup for goal continuation is fine.)

**Stuck detection:** if the polled state is byte-identical for ≥15 consecutive
minutes (no new agent completion, no status change, no output growth), surface
to the user. Any delta — even partial — resets the timer.

**A turn ends ONLY when:** (a) all work is fully complete, or (b) you need a
specific answer from the user that you cannot decide yourself. "It's progressing",
progress reports, summaries, and partial commits are NOT such reasons.

**Exception — server-owned work:** two commands hand the work to the jaw
SERVER; after they confirm, it is NOT in-flight for your turn — end the turn
and the server re-invokes you on completion:
1. `cli-jaw bgtask add` (e.g. `--preset web-ai --session $SID`) → re-invoked
   with a `[bgtask:*]` prompt (durable across server restarts).
2. `cli-jaw dispatch --async` (single or `--batch`) → the employee runs
   server-side; a completion notice re-enters via pending-replay (memory-only:
   a server restart before delivery loses the notice — recover with
   `cli-jaw worker status`).
Do NOT block on `web-ai query`-style long waits when a bgtask can cover them.
<!-- /anchor:session-poll -->
