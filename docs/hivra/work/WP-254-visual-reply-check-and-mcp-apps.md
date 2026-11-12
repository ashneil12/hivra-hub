# WP-254: Visual replies check themselves, and MCP Apps show in the chat

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | M | 130 | no |

## Goal

1. Before a visual reply is shown, the agent can look at it: the app renders the page off screen and hands the agent a
   screenshot and any script errors, so a broken chart is fixed before the person sees it.
2. When an MCP tool returns an MCP App (the MCP Apps standard, `ui://` resources), the chat shows it in the WP-130
   sandbox in place of the tool call.

## Why

Up.computer (docs/user/html-renders.md, MIT): "Before publishing, agents check their work with screenshots from a small
headless browser", and "MCP apps ... appear in the thread in place of the tool call". Hivra's WP-130 renders visual
replies but never shows the agent what it drew.

## Build

1. An app tool `visual.preview <html>` that renders through the same sandbox policy (WP-130: no network beyond the
   allowed CDNs, no parent access), returns a PNG path and the console errors. It never opens a window.
2. The visual-reply instructions tell the agent to preview once before answering and to fix script errors.
3. MCP Apps: when a tool result carries a `ui://` resource, render its HTML in the sandbox. Any tool call the app asks
   for goes through the normal approval unless the server marks the tool read-only; a message the app wants to post
   always asks.

## Done when

- [x] (preview part) Tests: the preview keeps the sandbox (a fixture that fetches is blocked); errors come back; an MCP App renders;
      an app's tool call asks first.
- [ ] Security review (this is a sandbox package).

## Built (12 Nov): the preview

- `visual.preview {"html"}` (app tool, agentApp.ts): the webview builds the same guest page a visual reply gets, always
  with the network locked, plus an error collector (visualReply.ts `visualPreviewDocument`). Rust
  (`src-tauri/src/visual_preview.rs`) draws it with a Chrome-family browser already on the Mac (Chrome, Chromium,
  Edge, Brave), headless, in a throwaway profile, then reads the page back for its errors. It returns the PNG's path
  (`<data>/visual-previews/`, cleared after an hour) and up to 20 errors. No window opens. No browser on the Mac: the
  tool says so and the reply goes out unchecked.
- The first-mate contract tells agents to preview once before sending a visual reply and fix what it reports.

## Security review (the preview)

1. Two locks on the network: the page's own policy (`connect-src 'none'`, no remote images, fonts, frames or forms,
   link tags dropped), and the browser started with every host name failing (`--host-resolver-rules=MAP * ~NOTFOUND`)
   and no proxy. An IP-literal request is stopped by the page policy alone, as in the chat. The real-browser test
   proves a `fetch` is blocked and reported.
2. A fresh profile per run, deleted after it; the page file is deleted too; only the PNG stays, for an hour.
3. Background networking, sync, extensions and component updates are off. Each run is stopped after 30 s.
4. The page is the agent's own HTML, shown only to the agent; the person's frame is unchanged.
5. The errors come back as data (capped at 20 lines of 500 characters), never run.

## Not built: MCP Apps (part 3)

Hivra isn't the MCP host in a Claude Code chat: Claude Code is. It reads the `ui://` resource (if it supports MCP Apps
at all) and hands Hivra only the tool result's text (claudeProtocol.ts `toolResultText`), so Hivra never gets the
app's HTML or a channel to answer its tool calls. Doing it needs either Claude Code to pass embedded resources through
its stream, or Hivra to proxy each MCP server (as `monocode computer-use` does for one). Left for a decision.
