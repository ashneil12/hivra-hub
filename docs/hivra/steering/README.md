# Steering and decisions (WP-14)

The spec is [work/WP-14-steering-decisions.md](../work/WP-14-steering-decisions.md); the code map is in
[src/features/firstmate/README.md](../../../src/features/firstmate/README.md).

## Steering

`task_message(taskId, text, whenBusy)` stores the message in `steer_messages` (src-tauri/src/steering.rs) before
anything delivers it. The webview (`useSteering`) drains pending messages on start, on every store change, whenever a
chat starts or ends a turn, and every 30 s:

| Worker chat | `auto` / `steer` | `queue` |
| --- | --- | --- |
| idle | starts a new turn | starts a new turn |
| busy, CLI can steer | steered into the running turn | held, goes in as the next turn |
| busy, CLI can't steer | held, goes in as the next turn | held |
| gone | failed | failed |

A message already in the chat's transcript under its request id (`steer-<id>`) is recorded as delivered and never sent
twice. A failed try waits 30 s; after 5 the message fails for good. One worker's messages go in order.

## Decisions

`ask_person(key, question, options, recommended, taskIds?, answer?)` stores one decision per `(project, key)` in
`decisions` (src-tauri/src/decisions.rs). Only a chat at the top of its work may ask; a worker, or a first mate working
for another first mate, is turned back to its own first mate. Asking again with a key changes nothing about the
question; it only adds waiting tasks, and an answered key returns its answer (and gives it to those tasks).

The person answers from the Needs row's "See options" sheet (WP-15 builds the Inbox on the same rows), or in the first
mate's chat, which passes their words as `answer`. Answering stores the answer and, in the same transaction, a steering
message with it for every waiting task still open and one for the first mate that asked. Their rows' questions go back
to their first mate, so they read as working again.

## Caps

All refuse with a plain reason; nothing is truncated or dropped: 8 open tasks per first mate (`check_fanout`, beside
WP-10's depth cap), 20 pending messages per worker, 8,000 characters per message, 2,000 per question or answer, 2 to 6
options, 20 tasks waiting on one decision.

## Credits

The durable inbox with a doorbell re-rung until acknowledged is firstmate's (`bin/fm-send.sh`,
`bin/fm-task-inbox-lib.sh`, MIT); hold and replay is PandaCode's; the decision gate with stable keys is AgentOS's
(MIT); refusing over a cap instead of truncating is OpenBot's. Ideas only; no code was copied.
