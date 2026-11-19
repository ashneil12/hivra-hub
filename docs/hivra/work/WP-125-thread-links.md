# WP-125: Local thread and prompt links, not public guest links

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | none | yes |


## Goal

A chat, and a composer prompt, can be copied as a local link (`hivra://` or the existing custom scheme if one already exists) that opens the right chat or fills the draft on this computer. There is no public or guest URL that works off-machine.

## Why

T3 added shareable thread links in [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7) and prompt links in [prompt-links.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/prompt-links.md). Its earlier guest links leaked file diffs and had to be patched in [v0.1.5](https://github.com/pingdotgg/t3code/releases/tag/v0.1.5) (#26538). Hivra should take the local convenience and skip the public surface.

## Read first

- Hivra: existing deep-link or custom URL scheme (search `hivra://`, `monocode://`, tauri deep link), chat routing, composer prefill.
- T3 behaviour (ideas only): [prompt-links.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/prompt-links.md). Do not implement [guest-links.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/guest-links.md).

## Build

1. Define a local URL shape for (a) open this chat, (b) open this project and prefill this prompt text. Reuse an existing scheme if the app already registers one. Tests for parse and reject of unknown or off-machine shapes.
2. Copy actions on the chat header and in the composer. Opening a link on a machine that does not have that chat says so; it does not invent a web viewer. Tests and a browser spec.
3. No guest, signed, or public URL path in this package. If you find leftover MonoCode share links, leave them alone or mention them in PR.md; do not turn them on.

## Done when

- [ ] Local links open a chat or prefill a prompt on this machine.
- [ ] A link for a missing chat is a clear error, not a blank window.
- [ ] No public or guest URL is introduced.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
