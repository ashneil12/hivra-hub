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
