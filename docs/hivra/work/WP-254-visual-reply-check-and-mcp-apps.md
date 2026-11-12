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

- [ ] Tests: the preview keeps the sandbox (a fixture that fetches is blocked); errors come back; an MCP App renders;
      an app's tool call asks first.
- [ ] Security review (this is a sandbox package).
