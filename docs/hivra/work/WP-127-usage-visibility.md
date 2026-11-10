# WP-127: Always-on context and limits, with filters, after WP-108

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | WP-108 (usage history). If 108 is not on main yet, build against its branch or leave a clear hook and say so in PR.md. Do not edit the WP-108 worktree | yes |


## Goal

Context remaining and usage windows stay visible while a chat is open, not only in a footer the person has to notice. The usage page (WP-108) can be filtered by provider and model. Custom prices, if shown, are clearly 'estimated, not your bill'.

## Why

Usage and context visibility had 23-59 upvotes in the 6 Nov T3 survey, and T3 later added filters in [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7) and a full [usage.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/usage.md) page. Hivra has a footer with 5h/7d reset times (`UsageFooter.tsx`) and a context meter. WP-108 is adding history. This package is the rest: always-on visibility and filters, without clashing with the 108 worktree.

## Read first

- Hivra: `UsageFooter.tsx`, context meter, `usageLimit.ts`. WP-108's usage history, if it has merged, and its files on main. Do not edit the WP-108 worktree if a builder is still running there.
- T3 behaviour (ideas only): [docs/user/usage.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/usage.md).

## Build

1. Keep context remaining visible in the open chat (reuse the existing meter; do not hide it on scroll). Tests that the meter stays mounted while a thread is open.
2. On the WP-108 history page (or a thin wrapper if 108 is not merged), add filters for provider and model, defaulting to all. Tests for the filter model.
3. Any dollar figure is labelled 'estimated, not your bill'. If you add optional custom prices, they are a local setting and never sent anywhere. Tests for the label.
4. Browser spec on Chromium and WebKit for the meter and the filters.

## Done when

- [ ] Context remains visible in an open chat.
- [ ] Usage history can be filtered by provider and model, or PR.md explains the hook left for 108.
- [ ] Estimates are labelled as estimates.
- [ ] The WP-108 worktree was not edited.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
