# WP-22: Groups: responder modes and goal mode

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| A | M | none | no |

## Goal

A group is a room where a person and several first mates or Monos talk, and each room says who answers: the lead,
whoever is mentioned, everyone, or a quick automatic pick. A room can also work toward a goal for a bounded number
of turns.

## Why

Ash: groups and councils are optional, and OpenMausBot is exceptional at agents talking. SPEC.md section 6. The
Hub's rooms already take turns well; this makes the rule a visible, per-room choice and adds goal mode.

## Read first

- `src/features/hub/model/roomConductor.ts`, `roomTurns.ts`, `hubChats.ts`, `src-tauri/src/rooms.rs`,
  `src/features/hub/ui/GroupChatView.tsx`, `docs/leadership/ROOM.md`.
- OpenMausBot (Apache-2.0 core, ideas only): `docs/decision-model.md` (auto pick that fails open),
  `server/group-goal-run.ts` (bounded goal loop with a control block), `shared/package-format.ts` (room responder
  kinds `agent`, `everyone`, `mentions`, `auto`).
- Buzz's standing prompt framing ("you are one of several sessions; don't take over another's work").

## Build

1. **Responder mode per room**: `lead` (the room's lead answers unless someone is @mentioned), `mentions` (only
   those mentioned), `everyone` (today's behaviour: the lead answers first, every other member may add a reply or
   stay quiet with NO_REPLY), and `auto`. Existing rooms keep today's behaviour.
2. **Auto** asks a fast, cheap model which member should answer (one, several, or unsure), given the members' names
   and roles and the last few messages. It must answer within 1.5 seconds; on any timeout, error, unsure answer or
   missing key it falls back to the lead, and the room never waits longer than that. It uses a model the person
   configured (an API key through `model_router.rs`), never a full CLI session. Show who picked ("picked
   automatically") under the reply.
3. **Goal mode**: the person gives the room a goal; the lead runs at most 13 turns, each time choosing who speaks
   next with an instruction, through a structured block the app parses and hides; it stops on completed, needs
   input or blocked, and says which.
4. Keep the existing brakes (posts without the person, parallel turn cap) and "X is back" reports.
5. Add the "one of several sessions" framing to every member's room turn.

## Done when

- [ ] Tests for each mode, auto's fallback on timeout, error and low confidence, and goal mode's turn bound and stop
      states (fake models).
- [ ] Browser spec: switching a room's mode and a goal run ending in needs input; `npm run check` passes.
