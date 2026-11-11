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

- [ ] Tests for each wait reason, the gathered answer with one member missing, and the single retry.
- [ ] Browser spec, with before and after screenshots.
