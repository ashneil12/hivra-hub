# WP-43: Browser plugin

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | M | 31 | yes |

## Goal

Agents can use a real browser, each with its own profile and logins, with safe defaults and a visible Stop.

## Why

Ash's browser control (vision item 8). Crest's ideas (per-agent spaces, driving indicator, safety defaults) with a
standard engine: Playwright MCP or Chrome DevTools MCP.

## Read first

- Crest (MPL-2.0; name not licensed): its README's Spaces, the driving bar, Stop and Stop All, and its safety
  defaults (script evaluation off, password and cookie redaction).
- Playwright MCP and Chrome DevTools MCP documentation (pick one; note why in the PR).
- WP-30 and WP-31.

## Build

1. A Browser plugin entry: the chosen MCP server, pinned, with a profile directory per first mate or Mono under the
   app's data folder (never the person's own browser profile unless they choose it).
2. Safe defaults: headless unless the person asks to watch; script evaluation off; passwords and cookies never in
   tool output; page content marked untrusted in tool descriptions.
3. While an agent drives a visible browser, the app shows which agent it is and a Stop control.
4. Profiles are listed in Settings with a clear button per profile.

## Done when

- [ ] Tests: install from the index, profile per agent, Stop ends the session (fake server).
- [ ] A dev-copy check: an agent opens a page, reads it and stops when asked.
- [ ] `npm run check` passes.
