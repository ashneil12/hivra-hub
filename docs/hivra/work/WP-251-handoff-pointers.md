# WP-251: A model switch keeps the first ask and points at what it left out

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | S | 121 | yes |

## Goal

When a chat moves to another engine and the transcript does not fit, the new agent still gets the person's original
request, the newest messages, and a list of the messages that were left out with a way to read them.

## Why

Up.computer's portable handoff (docs/user/portable-handoffs.md, MIT) favours "recent requests and answers, the
original request, and relevant activity", and "includes references to omitted history" that the agent can read with a
thread-reading tool. Hivra's `buildPortableTranscript` (`src/features/sessions/model/midThreadSwitch.ts`) keeps only
the newest messages and says how many older ones were dropped, so a long chat loses the ask that started it.

## Build

1. `buildPortableTranscript` keeps the first user message whole (cut only if it alone exceeds a quarter of the
   budget), then the newest messages that fit, newest first, in their original order.
2. The left-out marker lists each left-out message by role, its id and its first 80 characters, capped at 40 entries,
   and says how to read one: `app chat.message <chat id> <message id>` through the app's own tool.
3. The app tool `chat.message` returns one message's full text from the same chat only (a chat id other than the
   caller's is refused).

## Done when

- [ ] Tests: the first ask survives a long chat; the order holds; the pointer list is capped; a short chat is unchanged.
- [ ] Tool test: own chat answers, another chat is refused.
