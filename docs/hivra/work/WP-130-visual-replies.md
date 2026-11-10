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
- With network on, for that reply only: fetch, images, fonts and media may use `https:`, and fetch also `wss:`. Never plain `http:` or `ws:`, so a reply cannot reach a plain http server on this machine or the local network, the app's `http://asset.localhost` and `http://ipc.localhost` schemes, or `file:`. **This does not keep this machine or the local network shut.** `https:` also names `https://localhost`, `https://127.0.0.1`, private LAN addresses and `*.ts.net` names, so a reply with the network on can reach an https server there. A content policy cannot tell those addresses apart from the internet. Hivra does not route the frame through a proxy that refuses private addresses (the app's `page_http` proxy does that for its own fetches), so this is an accepted limit: a visible line says "Network on" while it is on. Remote scripts, remote styles, frames, objects, forms and navigation stay off. `script-src` stays `'unsafe-inline'` with no host. The choice is not saved. Closing the reply or leaving the chat turns it off again. While it is on, a one-line note says what it reaches.
- Always: `form-action 'none'`, `frame-src 'none'`, `child-src 'none'`, `object-src 'none'`, `base-uri 'none'`.

`navigate-to` is not part of the policy. Chromium and WebKit both report that directive as unrecognized, so it would not block anything.

Each reply is a shell frame with the guest frame inside it. The shell carries the same policy as its guest, so the guest, which inherits the shell's policy, can never get more than that. The shell policy sets `frame-src 'none'` and `child-src 'none'`, and it never allows a remote script. A guest that sets `location`, follows a link, or refreshes the page is navigating that inner frame, and both browsers refuse the request. It is not sent. WebKit leaves the guest in place. Chromium may drop the inner page after refusing, so a reply that tries to leave can go blank there. The sandbox also stops the guest navigating its parent or the top page: both throw a security error. Clicks on links that leave the page are cancelled as well. The person saves the file instead. Opting in does not add a remote script, a frame, a form or a navigation. DNS prefetch is turned off in the guest before the reply. The guest also drops `<link>` tags from the reply in one pass and stubs `RTCPeerConnection` and its WebKit variant before the reply runs. Both are speed bumps, not guarantees: see the known limits below.

A reply over 512 KiB of UTF-8 is not framed. A null byte in the reply is removed so it cannot cut the page short. Theme values are checked before they are written into CSS. A value with a breakout character, or a `url(`, is replaced with a plain fallback.

The frame starts from the current theme: background, text, the plain font and the mono font. Those are written as `--hivra-background`, `--hivra-text`, `--hivra-font` and `--hivra-mono`, and as the default background, color and font on the page. They are not forced. A reply that sets its own background, color or font comes later in the document, so that rule wins. The tokens stay available for a reply that wants to follow the theme.

## Detection

A fence renders as a visual reply only when it is marked, and only in the agent's own chat text: the assistant's reply in a chat transcript. Every other Markdown surface shows a visual fence as plain code: pull request bodies and comments, notes, artifacts, reasoning, subagent reports, release notes and documents. Those texts come from people or from content the agent read, so a stranger's comment never frames script. A reply that streamed while this window watched runs by itself. A reply loaded from history shows a Run visual reply button and runs only after a click, because history can hold text the agent copied from something it read. The agent is told about the fence in its guidance (`src/features/firstmate/contract.md`), so the marked form is used by the agent's own replies. The mark is the language `visual`, `visual-html` or `hivra-visual`. The only hint is an `html` or `htm` fence whose info string is the single word `visual`, with any letter case. A plain html fence, a javascript fence, inline html and an html fence with any other info string stay ordinary Markdown. A fence that is still streaming stays code, so a half-written reply is not framed.

Show source hides the frame and shows the reply as text. Show visual puts the frame back. Save as file saves the original reply: in the app it asks where to save (suggesting `visual-reply.html`) and writes the file, because the app's web view has no download handler and cancels a download link. Outside the app it downloads the file as `application/octet-stream`, so the bytes are never shown as a page. Allow network turns the network on for that one reply. The choice is not saved. Remote scripts, frames, forms and navigation stay off. A reply that is too big to frame is shown as source, with Save as file and no network switch.

The host ignores messages from the frame except a height number from that frame, and it caps the height. The frame cannot ask the app to open a link, run a tool or read the page.

Two replies do not share an origin. The shell passes on only a height from its own guest, rebuilt as a number, and it only forwards a theme message back in.

What the first browser spec (`wp130-visual-replies.spec.ts`) covers, on Chromium and WebKit: a fixture that fetches, loads an image, a script and a nested frame, reads the parent page, sets `location.href`, clicks a link, refreshes, and submits a form. The parent title stays put, `contentDocument` stays closed, and the harness sees no request for those targets. A browser the spec does not run could still treat frame navigation differently. The sandbox would still stop that page from touching the parent.

## In the app

A srcdoc frame inherits the policy of the page that holds it. The app's policy has `script-src 'self'`, so a srcdoc reply in the app would show its static HTML but its script, the theme helper and the height helper would never run (the same failure bespoke pages had on 22 Oct). In the app the shell is handed to Rust (`visual_frame_put`) and the frame loads `monoartifact://localhost/page-visual-<id>-<n>`, served by `src-tauri/src/page_frames.rs` with `sandbox allow-scripts` plus the visual policy for the network choice the person made. The policy is picked by the command that stored the document, never by its key. Visual replies keep their own 48 most recent documents, so a long chat does not push out a page. A unit test keeps the Rust policy strings equal to `visualFrameCsp` in `visualReply.ts`. If the app refuses the document, the reply shows its source with a note instead of a frame.

Store hygiene: a document is capped at 3.2 MiB (3,355,443 bytes). A reply at the 512 KiB source cap, with every quote escaped, fits under it. When a frame is replaced or unmounted the app drops its document (`visual_frame_drop`). The shell posts `hivra:visual-ready` when it loads. A frame that has not sent it after 8 seconds (for example, because its document was evicted) shows the source with a note instead of a blank frame. A browser with no source of randomness gets no frame id, so no frame: a predictable id would let a key be guessed.

Window messages: every window message listener that acts on a frame's message checks `event.source` against that frame's own window (`HtmlArtifactFrame`, `PagesView`, `PanelTabs`, `VisualReplyFrame`). That check is the barrier. A sandboxed frame has an opaque origin, so an origin check cannot tie a message to its frame. `src/features/sessions/ui/messageListeners.test.ts` fails if one of those listeners lacks the check.

What the frame cannot reach, proven under the app's own policy (`tests/browser/wp130-visual-replies-app.spec.ts`, Chromium and WebKit; the page carries the app's CSP from `tauri.conf.json`, Tauri globals with a secret, a cookie and a theme):

- `__TAURI__`, `__TAURI_INTERNALS__`, `__TAURI_IPC__` and `ipc` are undefined in the reply; `parent` and `top` Tauri globals, documents, titles, storage and the app's cookie are out of reach; `window.open` returns nothing; `top.location` does not move.
- With network off, fetch and images to the dev server, `127.0.0.1`, `file:`, `asset:`, `http(s)://asset.localhost`, `ipc:`, `http://ipc.localhost`, relative paths and a remote https host all fail. Every target is answered with 200 by the spec, so a failure is the policy, not a dead host, and none of them is reached.
- With network on, the remote https host loads. `https://127.0.0.1` and `https://localhost` also open: that is the known limit in the policy section. Every plain-http, `file:`, `asset:`, `ipc:` and app-scheme target still fails.
- The frame's background, text color and font are the theme's.

Local images: a reply's local path or `file:` image does not load. A visual reply never goes through the chat's media loader (`read_chat_image`), so it cannot widen what a chat may read.

Tauri: on macOS and Linux its startup scripts, which carry the IPC key, run in the main frame only (`for_main_frame_only`), and every IPC call must carry that key, so a frame there cannot call a command even where the IPC handler is visible. On Windows (WebView2) the startup scripts also run in subframes, so this claim is not made there and has not been proven; Hivra's visual replies are shipped for macOS first. The asset scheme answers with `Access-Control-Allow-Origin` set to the app's own origin, so an opaque-origin reply cannot read it.

Known limits, not closed by a content policy:

- On Windows with the https scheme the asset scheme is `https://asset.localhost`, which an `https:` source cannot name apart. With network on, a reply could show (not read) an image from the asset scope there. The Hub ships for macOS, where the asset scheme is `asset://`.
- WebRTC is not covered by CSP in Chromium or WebKit. The guest removes `RTCPeerConnection`, its WebKit variant, the data channel and the session constructors before the reply runs, but that stub covers only the guest's own window: a srcdoc child frame the reply makes gets a fresh `RTCPeerConnection` (checked in Chromium, 10 Nov 2026), so a live reply's script can still send a STUN request, which tells a server the person's IP and that the reply was opened. It has no app data to send. Closing it fully needs WebRTC turned off in the webview itself.
- The `<link>` strip is one pass over the reply's text, so a nested tag such as `<lin<link>k rel=preconnect …>` survives it, and a script can add a link element itself. A preconnect or dns-prefetch from a live reply can therefore still go out; like WebRTC, it carries no app data.
- Network on: `https:` reaches this machine and the local network (see the policy above). Nothing in the policy closes that; the warning line is the mitigation.

## Done when

- [x] A visual reply renders in a themed sandbox.
- [x] The sandbox policy is documented and tested.
- [x] Ordinary Markdown is not hijacked.
- [x] In the app the frame is served with its own policy, and saving writes a file.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
