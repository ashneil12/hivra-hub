# WP-130: Sandboxed visual HTML replies that follow the theme

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none | no |
 This package is Grok OK: no.

## Goal

When an agent returns HTML meant to be shown (a chart, a small app, an MCP App), Hivra can render it in a sandbox that follows the current theme, with no default network and no path out of the frame. The person can open the HTML as a file if they want more.

## Why

Visual replies are one of the feel items praised on [HN 50367589](https://news.ycombinator.com/item?id=50367589). T3 documents them in [html-renders.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/html-renders.md). Hivra has no equivalent on `origin/main`. This is a beat if the sandbox is tighter and themed. Grok OK: no, because this is an HTML sandbox.

## Read first

- Hivra: transcript message types, theme tokens, any existing iframe or preview pane, desktop plugin permissions.
- T3 behaviour (ideas only): [docs/user/html-renders.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/html-renders.md). Do not copy T3's iframe implementation; read it only to list threats you must close.

## Build

1. A sandbox policy written down in the WP doc and enforced in code: no network unless the person opts in for that reply, no parent DOM access, unique origin, size limits, CSP. Tests that a fixture payload cannot fetch or script-escape (as far as the test harness can prove).
2. A renderer that applies current theme tokens (background, text, fonts) to the frame, or documents why a given payload cannot be themed. Tests and a browser spec.
3. Detection: only render when the agent marks the payload as a visual reply or it matches a conservative, documented hint. Ordinary Markdown HTML stays as today's Markdown. Tests for false positives on normal replies.
4. A way to download or open the HTML as a file, and a way to not render (show the source instead).

## Done when

- [ ] A visual reply renders in a themed sandbox.
- [ ] The sandbox policy is documented and tested.
- [ ] Ordinary Markdown is not hijacked.
- [ ] Grok builders did not start this package.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
