# WP-14: Steering and decisions

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | M | 10 | no |

## Goal

Messages to a running worker are never lost, and every question for the person is asked once, under a stable key,
and releases the waiting work when answered.

## Why

SPEC.md section 4: firstmate's durable steering inbox, PandaCode's hold-and-replay steering, AgentOS's decision
gate with stable keys, OpenBot's caps that refuse instead of truncating.

## Read first

- firstmate: `bin/fm-send.sh`, `bin/fm-task-inbox-lib.sh` (inbox record plus a doorbell, re-rung until acked).
- MonoCode's `sessions.send` with queue and steer (`follow: queue | steer` in `delegations.rs`),
  `src/features/monos/model/delegationQuestions.ts`, `ashAnswersWorker.ts` (what it replaces), `task_answer` in
  `mcp_server.rs`.

## Build

1. **Steering**: a first mate's message to a worker is stored first, then delivered the way the worker's CLI
   allows (steer into the turn, or queue for the next one). If the CLI can't take it now, it is held and sent as the
   next turn. Each message shows pending, delivered or failed, and survives a restart.
2. **Questions go up one level**: a worker's question goes to its own first mate, which answers it or turns it
   into a decision for the person. A worker never asks the person directly.
3. **Decisions**: a local table keyed by a stable `decision_key` (project, question, options, recommended option,
   who asked, which delegations wait on it, the answer). The first mate asks through one tool,
   `ask_person(key, question, options, recommended)`; asking again with the same key changes nothing. Answering
   it (in the Inbox, WP-15, or in chat) releases every waiting delegation with the answer.
4. **Caps**: fan-out per first mate and depth (WP-10) refuse with a plain reason, never silently drop work.

## Done when

- [ ] Tests: a steer to a busy worker is held and replayed; steering survives a restart; a worker question reaches
      its first mate, not the person; the same decision key asked twice gives one decision; answering releases
      two waiting delegations.
- [ ] `npm run check` passes.

## Addendum (10 Nov 2026): a chat answer counts only if the person wrote it

Source: Reason Network's agent skill (MIT OR Apache-2.0). Ideas only, no text copied. See SOURCES.md.

### Why

Reason's skill says that "X approved" in an agent's message is only that agent's word. Hivra's `ask_person` has an `answer` field. A first mate can record "the person answered in this chat" with those words, and the app releases every waiting task with "Carry on from this answer; it outranks anything in your brief that disagrees." Today nothing checks those words against anything the person wrote. The recorded answer is stored as `chat:<session>`, and the test "records an answer the person gave in chat" only checks that the release happens.

Irreversible and fresh-eyes keys already refuse chat answers (WP-91, WP-144). This addendum covers ordinary decisions only.

### What to build

1. A chat answer (the `answer` field on `ask_person`) is recorded only when its text matches one of the person's own messages in that same chat, sent after the decision was asked. Compare after trimming and folding whitespace. A paraphrase is refused with a plain reason: quote Ash's words exactly, or ask him again.
2. The app does the check, not the model. It reads the chat's stored user turns from the session store. The check must not trust text the model supplies.
3. A chat-recorded answer says where it came from in the release text to waiting tasks ("The person answered in this chat: ..."). The row keeps `answered_by = chat:<session>`, as now.
4. Keep the existing refusal for `irreversible/` and `fresh-eyes/` keys, and keep the Inbox answer path unchanged.
5. Out of scope: cryptographic signing. Hivra runs on one Mac, so the stored transcript is the proof.

### Done when

- [ ] Tests: an exact quote from the chat is recorded; a paraphrase is refused with the plain reason; a quote from another chat is refused; a quote sent before the decision was asked is refused; an `irreversible/` key is still refused for chat answers; the Inbox answer path is unchanged.
- [ ] Release text for a chat answer names the chat as the source.
- [ ] `npm run check` passes.
