# WP-245: Each agent's queue says why it waits, and answers from many agents arrive together

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | M | none | yes |

## Goal

Ash can always see why a message hasn't been answered yet. A question sent to several agents comes back as one
answer, not a scatter.

## Why

nightly-labs OpenBot (ideas only, no code or text):
- each agent has a queue with lanes and a visible reason for every wait;
- answers to a request sent to several agents are held and arrive in one turn;
- a turn that ends with no answer is retried once, then fails visibly;
- group chats pick who answers without a model where they can.

## Build

1. Every queued message carries a plain wait reason: "behind 2 messages", "waiting for Ash's approval", "paused by
   Ash", "usage limit until 14:00" or "the engine is starting". Show it on the queued bubble.
2. A request fanned out to several first mates or crew (a room, a council, a captain's round) collects their
   answers and delivers them as one block when all have answered or the timeout passes, naming who didn't answer.
3. A turn that ends with no text and no tool call is retried once with a short note, then shown as failed.

## Done when

- [x] Tests for each wait reason, the gathered answer with one member missing, and the single retry.
- [x] Browser spec, with before and after screenshots.

## Built

- Wait reasons: `src/features/sessions/model/queueWaitReason.ts` names the reason the queue already has (it decides
  nothing): "Paused by you", "Usage limit until 14:00" (or "waiting for it to reset"), "Behind N messages", and for
  the first message "Waiting for your approval", "Waiting for your answer", "The engine is starting", "Waiting for
  the interrupted reply to resume", "You're editing it" or "After the current reply". It shows as one quiet line on
  each queue row (`MessageQueue.tsx`, `data-queue-wait`) and under a first mate's pending bubble
  (`monoMessaging.ts` `waitReason`, `AgentTranscript.tsx`, `data-message-wait`). A failed or paused bubble keeps its
  own words and control. The count includes app notes in the queue.
- Gathered answers (rooms): `roomConductor.ts`. When several seats answer one message of Ash's (several mentioned,
  an auto pick of several, or an "everyone" room's chimes), each finished answer is held as a live message that says
  "Waiting for the others to answer" until every seat has answered, stayed quiet or failed, or `GATHER_MS` (3
  minutes) passes. Then they land together in seat order, marked with one `gather` id (kept in the room store; a
  thin rule at their left), and a seat still writing is named: "No answer from Ed within 3 minutes." Its answer
  lands on its own when it comes. Ash writing again or pressing Stop lands what is held at once. On by default;
  `setRoomGathering(false)` turns it off. A council already gathers through its own protocol (`council/model`), and
  a captain's round through the 20-second report window (`REPORT_WINDOW_MS`, which names what is still running);
  neither was changed.
- Empty turns: `src/features/sessions/model/emptyTurn.ts`, wired in `submitSession` (`App.tsx`). A completed turn
  with no words, no tool, no approval or question and no error line gets one app note (`[MonoCode empty turn]`, shown
  as "The reply came back empty, so the app asked once more"); empty again, it is failed with "The agent ended its
  turn twice without saying anything." Whoever waits on the turn hears the retry's outcome. Slash commands (other
  than `/operator`) and a chat with something queued are left alone.
- Shots: `docs/hivra/work/shots/wp-245/before.png`, `after.png`. Specs: `queueWaitReason.test.ts`,
  `emptyTurn.test.ts`, `src/features/hub/model/roomGather.test.ts`, `tests/browser/wp245-queue-lanes.spec.ts`.
- The idea of a reason for every wait, held answers and one retry is from nightly-labs OpenBot; none of its code or
  text is used.
