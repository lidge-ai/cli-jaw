# Slack tools

Use `jaw slack capabilities` to inspect registered operations and observed bot scopes. `implemented` describes server support, `granted` is the current scope observation (or unknown), `available` describes base prerequisites, and `verified` records a successful real operation under that credential. `conditionalScopes` lists conversation-dependent permissions; known requester-DM access and mutation readback scopes are included in `requiredScopes`. Resource access, workspace plan, and conversation restrictions are checked separately on each call. Parent-agent connectors do not provide tools to this bot.

Call `jaw slack tool --input-json '<JSON>'`. The server accepts explicit operations; it does not accept arbitrary Slack API methods. Auto/full local access needs no manually copied tool credential. Outside that path, supported fresh print-process Slack turns use an expiring grant, and operators may explicitly use `--operator` with the separate instance credential.

## Full local API access

The instance's stored `permissions:"auto"` policy enables full authority for
qualified direct local Jaw API requests. This includes history, source/action
tools and explicit channel/file sends, independently of print, native reuse,
resume, steer or worker role. Ordinary browser, memory, settings, skill, task and
goal APIs keep their existing instance authentication. Full dispatch uses the
same server policy while preserving task constraints and worker ownership.

Both the socket peer and effective peer must be loopback. Existing authentication,
Host and Origin checks still run; automatic promotion additionally requires a
valid local Host, exact Origin when present, and absent/same-origin/none fetch
metadata. Forwarded and generic Manager-proxy requests are not promoted merely
because their final hop reaches localhost. Explicit scoped/operator credentials
remain available on those paths. Full mode does not read or create an operator
token for headerless calls.

Full-local sends require an explicit `target`, `chat_id`, or `turn_conversation`.
They may use any valid destination accepted by the connected provider and any
resolvable regular file accessible to the OS account. They do not use the
last-active destination or change inbound allowlists. Invalid paths, file limits,
provider scopes, resource integrity and privacy exclusions still apply.

Full authority is independent of a stale automatically attached grant. A valid
grant supplies context only for the protected `search.quote` workflow, which
retains its existing turn, token, expiry, membership and privacy checks.
Capabilities report `authorization.mode` and keep authorization separate from
provider availability and verified results.

Safe/custom instance policies receive no automatic promotion. Each new HTTP
request is checked again; already-admitted requests may finish. This is an
instance-wide local-operator policy, not a per-process sandbox: a Safe provider
session inside an Auto instance can still access the same local APIs. Explicit
read-only and no-descendant task instructions remain binding.

All actions below take `operation` and `channel`. Mutations also require a unique `invocationId`. Repeating an identical completed invocation returns its saved receipt; conflicting, pending, or uncertain invocations cannot be sent again automatically.

| Operations | Additional input |
| --- | --- |
| `reaction.add`, `reaction.remove` | `ts`, `name` |
| `reaction.get` | `ts` |
| `message.update` | `ts`, optional `threadTs`, `text`, optional `blocks` |
| `message.delete` | `ts`, optional `threadTs` |
| `schedule.create` | Unix-seconds `postAt`, `text`, optional `blocks`, `threadTs` |
| `schedule.list` | None |
| `schedule.cancel` | `scheduledId` |
| `schedule.update` | `scheduledId` and changes to `postAt`, `text`, `blocks`, or `threadTs` |
| `pin.add`, `pin.remove` | `ts` |
| `pin.list`, `bookmark.list` | None |
| `bookmark.add` | `title`, HTTPS `link`, optional `emoji` |
| `bookmark.edit` | `bookmarkId`, changes to `title`, `link`, or `emoji` |
| `bookmark.remove` | `bookmarkId` |
| `canvas.create` | `title`, `markdown` |
| `canvas.read` | `canvasId` |
| `canvas.edit` | `canvasId`, `mode` (`append` or `replace`), `markdown`; replacement needs `sectionId` or explicit `replaceAll:true` |
| `list.create` | `name` |
| `list.read` | `listId`, optional `cursor`, `limit` (1–100) |
| `list.item.add` | `listId`, `fields` |
| `list.item.update` | `listId`, `rowId`, `fields`, optional `updatedTimestamp` |
| `interaction.url` | `text`, `buttons:[{text,url}]`, optional `threadTs` |
| `interaction.choice` | `text`, `choices:[{label,value}]`, optional `style` (`buttons` or `select`), `threadTs`, `expiresInSeconds` (1–900) |
| `interaction.get` | `interactionId` |
| `rts.reconcile` | Original publication `invocationId`, matching `threadTs` if applicable, optional `maxPages` (1–10) |

List fields use `{columnId,type,value}`. Supported types are `text`, `number`, `checkbox`, `date` (`YYYY-MM-DD`), and `user` (an array of user IDs). Unknown column schemas are rejected.

Message edits and deletion require the current bot's actual author identity. Reaction reads return reaction state, not the underlying message body. Pins and bookmarks use current conversation permission; their presence does not prove that the caller created them.

Schedules are tied to the exact creating credential. A changed token cannot prove that an older schedule disappeared. Updates cancel the old schedule and create a replacement; this is not atomic. Multi-message schedules can also finish partially. Receipts retain acknowledged IDs and never request blind retries. Slack does not support cancellation within the final 60 seconds, and scheduling never sends the problematic `metadata` parameter. List results identify incomplete scans and unresolved older credentials.

Canvas and List tools in Slack turns currently require a freshly verified requester/bot DM: requester access alone cannot authorize disclosure to a group. Writes require both the local ownership record and fresh requester write permission. DM Canvas creation uses a standalone document and requests direct write access for the captured requester; plan or sharing restrictions remain explicit and never trigger channel creation. Create/share acknowledgements do not prove requester visibility. Canvas content comes from the actual file download URL returned by Slack; missing access, unsupported format, incomplete content, and plan restrictions remain explicit.

Choices allow at most ten options and require the connected Socket transport. The server binds opaque controls to the captured requester, conversation, posted message, credential and expiry. A valid callback stores the selected value once; it does not execute code, an API method, or a model prompt. `interaction.get` reads that owned result. Choice verification in the catalog requires an observed callback; URL controls use posted-content readback. General modal opening is explicitly unsupported.

`rts.reconcile` sends no message and returns no source text. It can release only a terminal publication hold with matching ownership and exact scope after a complete scan proves the expected output count. Active publishers, incomplete scans, legacy holds, and crash records without terminal evidence remain protected. New RTS publication uses one payload and one POST attempt.

Source tools retain their separate shapes: `message`, `permalink`, and `quote` use `source:{channel,ts,threadTs?}`. `quote` requires `invocationId`; a direct `excerpt` must occur in the fresh source, while `summary` is labelled separately. `search.quote` requires the current inbound action token and publishes approved source excerpts in Slack, returning only output receipts. Search response bodies remain excluded from subsequent agent history.

Action receipts distinguish `verified`, `partial`, `unknown`, and `failed`. A known posted or scheduled ID survives a later readback failure. Store and response limits can produce an explicit partial result. Scope presence, a successful write acknowledgement, and verified content are separate observations. HTTP workflow guards do not isolate a full-shell agent from credentials readable by the same OS account.

The manifest subscribes to `message.mpim` with optional `mpim:history`. These arrive as `message` events with `channel_type:mpim`; explicit bot mentions remain admissible, while group allowlists and mention-only rules still apply. Group DMs are not treated as one-to-one DMs. Existing installations require a reviewed Slack app update and reauthorization; editing the manifest grants nothing by itself. No group-creation permission is added.

Optional action permissions are separate from core messaging: `reactions:read`, `pins:read/write`, `bookmarks:read/write`, `canvases:write`, `lists:read/write`, and `search:read.public`. Request only the missing scopes for the operations being enabled. The runtime catalog reports actual observed grants; plan-dependent APIs can still refuse a request.

On startup, the prompt builder appends a versioned Slack tool anchor to a user-edited A1 without replacing the user's text. A2 updates use `PUT /api/prompt` with the full `content` string. Preserve unrelated A2 instructions. B and working-directory AGENTS must be inspected after application: a successful PUT response alone does not prove both files were written. Prompt generation retries a failed or missing output even when its desired content hash is unchanged.

Use authenticated `GET /api/prompt?withGenerated=1` to compare the current generated expectation with both disk outputs. Require `generated.bMatches` and `generated.agentsMatches` to be true and independently compare the reported expected hash/byte length with the files. Keep A2's exact round-trip check separate from generated output, which can transform path notation.


## When replies work but attachments fail

Ordinary final replies are sent by the server. An agent attaching a local file uses
the authenticated Jaw tool route. Outside qualified local Auto, this requires a
scoped grant or explicit operator credential. A connected bot and `files:write`
do not by themselves establish that authority. `slack_turn_grant_required` means the request credential is missing;
`slack_turn_grant_invalid` means a supplied credential is no longer valid. Both
are separate from Slack refusing an operation for a missing scope.

Inspect `jaw slack capabilities` from the agent's runtime and check both transport
support and current availability. Use a supported request path and the exact
conversation and parent thread supplied to that request. Do not drop an explicit
destination, retry against the last-active conversation, or switch to operator mode
to bypass an agent-tool refusal. Preserve any returned delivery receipt before
deciding whether a failed request could already have posted something.
If a direct local Auto request still requires a grant, check the loaded server
build and whether the request crossed a proxy; a Slack scope or plan change does
not repair a Jaw authorization failure.

## Authorization and deployment boundary

This ships under an explicitly accepted deployment model, recorded in [issue #646](https://github.com/lidge-ai/cli-jaw/issues/646)
and tracked with the rest of the Slack integration in [issue #645](https://github.com/lidge-ai/cli-jaw/issues/645).
The repository owner accepted the residual limitations below for a self-hosted, single-operator
install. Anyone running cli-jaw where the OS account is shared with untrusted parties, or where
remote users must not reach bot authority, must not enable these tools until the isolation work
in #646 lands.
The assets are Slack credentials, source message content, and write authority. Authenticated
Slack ingress binds an actor, workspace, destination and request to a short-lived grant;
HTTP callers cannot supply their own actor or bot token. Scoped grants enforce membership and disclosure
checks; qualified local Auto uses the operator authority described above. Source search output stays server-side and durable
publication holds prevent its contents from returning through history after uncertain sends.

These are HTTP workflow controls, not a sandbox. An agent with arbitrary shell or filesystem
access under the server's OS account can read the operator credential or other server secrets.
File mode 0600 and the separate operator header do not prevent that escalation. The threat
model therefore assumes trusted local operators and does not protect against a compromised
same-account agent. Do not deploy this as a security boundary for untrusted remote users
until operator credentials and execution are isolated from agent-readable storage.

Scoped grant delivery remains limited to fresh main print processes for Cursor,
Claude, Codex and Grok. That limitation does not apply to qualified local Auto
requests, including native and worker callers. Without full-local or an explicit
credential, the catalog remains readable but reports `turn_authorization_unavailable`.
Ordinary final replies keep their server delivery path. Do not copy an operator
secret to evade a refusal on a non-full request.

Turn-created posts and schedules inherit the captured destination thread. A caller cannot
select another thread. Channel-level resource tools are in-conversation rather than in-thread:
pin/reaction/bookmark creation may target any message in the captured destination channel,
which the actor is already a verified member of. Only edits, deletions and removals are
narrowed further by the ownership record below. Message edits/deletes, bookmark edits/removals and pin removals require
an active resource record for the same actor, bot, credential, channel and thread. Untracked
messages, including historical ordinary replies, require an explicit trusted operator.
This keeps historical administration available without granting every channel member control
over another requester's bot output. These operator controls retain the isolation blocker above.

Directory reads are requester-visible workspace data. A turn grant that proves membership in
its destination can read the workspace user directory through the existing messaging route;
this is the same roster any member sees in Slack, not thread-scoped data.

The operator credential is minted on first operator use, not at boot, so an install that never
uses operator mode leaves no operator secret on disk. That narrows exposure; it does not change
the trust model above for installs that do use it.

Transport success is separate from rendered-content verification: `ok:true` from the ordinary
send transport means all posts succeeded, not that rich content was verified. Source quote
receipts use their own exact saved-block readback. Action receipts use their operation's
readback and retain `partial` or `unknown` when it cannot prove the requested result.

### Slack file upload receipts

`jaw slack send C123 --file ./report.pdf --thread 1712345678.123456 --caption "Report" --json` sends one file to an explicit conversation. Omit `--thread` for a channel-root post. `--operator` is explicit; normal CLI calls use existing instance/turn headers and the full-local policy. The command never infers a destination, retries a POST, or substitutes text for a failed upload.

The `upload` receipt records `stage` (`validation`, `reservation`, `upload`, `completion`), `state` (`failed`, `unknown`, `completed`), requested `channelId`/optional `threadTs`, and a known `fileId`. `verification: not_checked` means no content or visual readback was performed. Only a successful HTTP and Slack completion acknowledgement yields `ok: true, sent: true`. A reservation or accepted bytes alone do not prove delivery. If the completion reply is lost or contradictory, `sent: unknown, retryable: false` preserves that uncertainty. A later cancellation cannot erase an acknowledged send.

Files must be regular, nonempty and at most 50 MiB. The three-stage request has a shared 120-second cancellation bound. An oversize file with a caption returns a failure and posts nothing. CLI success requires a matching completed receipt; legacy bare success or caption-only responses exit nonzero as unconfirmed.

### Letting one other bot start a turn

Inbound gating refuses bot messages: the `bot_message` subtype is ignored, `allowBots: false`
refuses anything carrying `bot_id` or `bot_profile`, and a channel message that mentions the app
defers to its `app_mention` twin. Turning `allowBots` on to admit one scheduled trigger admits
every bot in every allowed conversation, which is rarely what an operator wants.

`slack.trustedBotTriggers` names the exception instead. Each strict rule has four required fields and an optional `workflowSkill`; unknown fields are rejected:

```json
"trustedBotTriggers": [
  { "channelId": "C123", "botId": "B123", "userId": "U123", "textMarker": "EXAMPLE_WORK_V1", "workflowSkill": "example-work" }
]
```

`channelId` is a channel or private group, `botId` is the sending app's `bot_id`, `userId` is the
bot user it posts as, and `textMarker` is an uppercase word the trigger message must contain. Read
the first two from a real message the trigger bot posted rather than guessing: a stale id means the
trigger silently never fires.

A post is admitted only when it mentions this app, its bot identity is internally consistent and
not deleted, and one rule matches the channel, bot, sender and marker as a whole word. That opens
exactly the three refusals above. The conversation allowlist, self-echo protection, `mentionOnly`
and the empty-event check still apply, so a rule cannot reach a conversation `channelIds` excludes.

The list validates as a whole: one malformed rule disables every rule, and at most 16 are read. A
typo therefore fails closed instead of leaving half the list live. Copying the marker text does not
help anyone else — Slack attests `bot_id` and `user`, so only the named app satisfies its rule.

`workflowSkill` selects an operator-configured execution route only after the actual event matches
all sender, channel, bot-user and marker checks plus a self-mention. Message text cannot select a
different skill. Existing four-field rules without `workflowSkill` retain their legacy behavior.
Only the selected enabled skill is loaded, with a 64 KiB read bound. Unverified sender/request
context (`source_unavailable`), an unavailable skill (`skill_unavailable`), or ambiguous selection
(`ambiguous`) visibly blocks the automation with `slack.workflow.unavailable`; check configuration. There is no model fallback. Normal approval, tool grants and source access
permissions still apply.

Read the selected skill at admission. Its captured content, hash and source metadata survive
queueing and restart. When busy, opted-in workflow requests use the `followup` queue; never steer
or collect them into an unrelated running turn.

An empty result or standalone `SILENT` result from a registered workflow produces a visible
unconfirmed notice (`slack.workflow.unconfirmed`) and a failure ACK, not silent success.
This settles the workflow request as unconfirmed/failed while preserving provider/native final
text and status.
Work may already have begun: inspect its records before retrying. Do not automatically rerun it.
A substantive AI reply alone is not proof that the requested business operation completed.
