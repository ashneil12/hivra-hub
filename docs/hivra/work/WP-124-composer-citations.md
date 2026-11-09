# WP-124: Composer citations pack: quote, edit, stash, large paste, mentions, switch history

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none. Do not include cache-compact or honest 'cannot do X' messages; those are another worker's T3 polish pack | yes |


## Goal

The composer and transcript gain the small citation and draft tools people praise in T3: quote a reply into the draft, edit an earlier prompt (with a clear history of the edit), stash and restore a draft, turn a large paste into a file attachment, mention models in the draft, and see where the model changed (the last of these also belongs with WP-121; share a marker component if 117 has already landed, otherwise add a simple one here).

## Why

HN thread [50367589](https://news.ycombinator.com/item?id=50367589) and T3's own composer docs treat citations and stash as everyday feel, not extras. T3: [composer.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/composer.md) (including the 32 KiB paste-as-file rule), stash keybinding, nightly model mentions, [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7) model-switch history. Hivra's composer does not have this pack. Cache-compact and 'cannot do X' are out of scope.

## Read first

- Hivra: composer components, draft store, message edit if any, transcript selection.
- T3 behaviour (ideas only): [docs/user/composer.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/composer.md). T3's 32 KiB threshold is a starting number; pick a threshold, document it, and test it. Do not translate T3 composer source.

## Build

1. Quote: from a user or assistant message (or a selected span), append a clearly marked quote block to the draft. Tests for the model; browser spec.
2. Edit earlier prompt: a sent user message can be edited and resent from that point, with a visible note that later replies belong to the earlier prompt. Confirm before discarding later work, or offer a fork (if WP-123 has landed, reuse it). Tests for the confirm path.
3. Stash: a command (and a shortcut if it does not clash) saves the current draft and clears the composer; restore puts it back. Survives a app reload. Tests for persist and restore, including attachments.
4. Large paste: pasting text over a documented size threshold becomes a file attachment, with a one-line note in the composer, and a way to undo back to inline text. Tests for the threshold and the undo. The threshold stays 32 KiB of UTF-8, the rule the composer already uses. This package adds the undo and does not change that size.
5. Mention models: typing a documented trigger (for example @) can insert a model or CLI mention the next send will honour, or be ignored with a reason if that CLI cannot take over mid-draft. If WP-121 is not merged, mentions may only record intent and show a 'will start a new chat' note. Tests for parse and ignore.
6. Model-switch history: if WP-121 has not landed a marker, add a simple one when the person changes model between turns. Do not duplicate 117's handoff work.

## Done when

- [ ] Quote, edit-with-confirm, stash, large-paste-as-file, and mentions each have tests.
- [ ] A switch marker exists, or PR.md points at the WP-121 commit that already added it.
- [ ] Cache-compact and 'cannot do X' were not implemented here.
- [ ] Browser specs cover quote, stash, and large paste.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
