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

## Sandbox policy

A visual reply is a shell iframe with the guest iframe inside it. Both sandboxes are exactly `allow-scripts`. Neither gets `allow-same-origin`, so each origin is opaque and unique, and the reply cannot read the parent page, its storage, its cookies or Tauri. It also does not get forms, popups, downloads, modal dialogs or top navigation.

The guest document carries a content security policy, written before the reply so the reply cannot close it:

- With network off (the default): `default-src 'none'`, inline scripts and styles only, images and media from `data:` and `blob:` only, fonts from `data:` only, `connect-src 'none'`.
- With network on, for that reply only: fetch, images, fonts and media may use `http:`, `https:`, and for fetch also `ws:` and `wss:`. Remote scripts, remote styles, frames, objects, forms and navigation stay off. `script-src` stays `'unsafe-inline'` with no host. The choice is not saved. Closing the reply or leaving the chat turns it off again.
- Always: `form-action 'none'`, `frame-src 'none'`, `child-src 'none'`, `object-src 'none'`, `base-uri 'none'`.

`navigate-to` is not part of the policy. Chromium and WebKit both report that directive as unrecognized, so it would not block anything.

Each reply is a shell frame with the guest frame inside it. The shell policy sets `frame-src 'none'` and `child-src 'none'`, and it never allows a remote script. A guest that sets `location`, follows a link, or refreshes the page is navigating that inner frame, and both browsers refuse the request. It is not sent. WebKit leaves the guest in place. Chromium may drop the inner page after refusing, so a reply that tries to leave can go blank there. The sandbox also stops the guest navigating its parent or the top page: both throw a security error. Clicks on links that leave the page are cancelled as well. The person saves the file instead. The guest also inherits the shell policy, and the two are combined, so the shell allows the same image, font, media and fetch schemes the guest may opt into. The guest policy is what keeps those off until the person opts in. Opting in does not add a remote script, a frame, a form or a navigation.

A reply over 512 KiB of UTF-8 is not framed. A null byte in the reply is removed so it cannot cut the page short. Theme values are checked before they are written into CSS. A value with a breakout character, or a `url(`, is replaced with a plain fallback.

The frame starts from the current theme: background, text, the plain font and the mono font. Those are written as `--hivra-background`, `--hivra-text`, `--hivra-font` and `--hivra-mono`, and as the default background, color and font on the page. They are not forced. A reply that sets its own background, color or font comes later in the document, so that rule wins. The tokens stay available for a reply that wants to follow the theme.

## Detection

A fence renders as a visual reply only when it is marked. The mark is the language `visual`, `visual-html` or `hivra-visual`. The only hint is an `html` or `htm` fence whose info string is the single word `visual`, with any letter case. A plain html fence, a javascript fence, inline html and an html fence with any other info string stay ordinary Markdown. A fence that is still streaming stays code, so a half-written reply is not framed.

Show source hides the frame and shows the reply as text. Show visual puts the frame back. Save as file downloads the original reply as `visual-reply.html` and does not open it in the app. Allow network turns the network on for that one reply. The choice is not saved. Remote scripts, frames, forms and navigation stay off. A reply that is too big to frame is shown as source, with Save as file and no network switch.

The host ignores messages from the frame except a height number from that frame, and it caps the height. The frame cannot ask the app to open a link, run a tool or read the page.

Two replies do not share an origin. The shell only forwards a message from its own guest, and it only forwards a theme message back in.

What the browser spec covers, on Chromium and WebKit: a fixture that fetches, loads an image, a script and a nested frame, reads the parent page, sets `location.href`, clicks a link, refreshes, and submits a form. The parent title stays put, `contentDocument` stays closed, and the harness sees no request for those targets. A browser the spec does not run could still treat frame navigation differently. The sandbox would still stop that page from touching the parent.

## Done when

- [x] A visual reply renders in a themed sandbox.
- [x] The sandbox policy is documented and tested.
- [x] Ordinary Markdown is not hijacked.
- [x] Grok builders did not start this package.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
