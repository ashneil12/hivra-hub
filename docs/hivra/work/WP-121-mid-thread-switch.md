# WP-121: Switch provider or model mid-thread without starting a new chat

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none | yes |


## Goal

The person can change provider or model in the current chat and keep going. The thread id stays the same. Selected messages (or a clear default: the whole thread so far) travel as a portable handoff the new harness can resume from. If a harness cannot resume, the UI says so and offers a recap into a new thread as the fallback, which is today's behaviour.

## Why

Seven independent voices in the 6 Nov survey named mid-thread switch as a reason they stay in T3. T3 shipped it as a first-class V2 feature with documented caveats ([portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/portable-handoffs.md), [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0)). Hivra today recaps into a new thread (`src/features/sessions/model/handoff.ts`). Model-switch history shipped in T3 [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7); include a visible marker in this package.

## Read first

- Hivra: `src/features/sessions/model/handoff.ts` and every caller, the model picker in the composer, chat transcript types.
- T3 behaviour (ideas only): [docs/user/portable-handoffs.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/portable-handoffs.md). Honour T3's own caveats: not every provider can truly resume; do not pretend otherwise.

## Build

1. A handoff model: given a thread, a target provider and model, and an optional set of message ids, produce a portable transcript the target can start from. Default is the whole thread so far. Tests for selection, empty thread, and a provider that refuses resume (the fallback path returns today's recap, and a reason string).
2. Wire it to the existing picker so a mid-thread change keeps the same thread id when resume is possible. Show a timeline marker when the model or provider changed (T3 v0.1.7 'model switch history'). The old recap-into-new-thread path stays as the fallback and is labelled as such. Tests with the session port stubbed.
3. Composer and chat header copy: 'Continue this chat with …' versus 'Start a new chat with a recap, because … cannot resume'. No silent switch. Browser spec on Chromium and WebKit.

## Done when

- [ ] Changing provider mid-thread keeps the thread id when the target can resume.
- [ ] A target that cannot resume is explained, and today's recap path is the fallback.
- [ ] A visible marker records each switch.
- [ ] Browser spec covers both the resume and the fallback copy.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
