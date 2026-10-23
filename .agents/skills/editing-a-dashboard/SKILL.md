---
name: editing-a-dashboard
description: Change a kept Page (dashboard) from Ash's words with Rebuild — decide blocks or bespoke, keep the data asks and taps it really needs, connect a web source through Ash, and restyle with theme tokens — so the new version looks like the rest of the hub and waits for his tap. Use when he says "change this page", "add a column", "show me X on that dashboard", or asks for a new page like one he already keeps.
---

# Editing a dashboard

A Page is code Ash keeps by tapping **Keep and allow**. Changing it is the same path: he says what should change,
a seated Mono answers with the changed page, and the new version waits on the page for his tap. Nothing replaces a
page he is using until he chooses it.

## 1. Start from the page as it is
- Rebuild (beside the pin on a kept page) sends the page as it is now, so change it rather than starting over:
  keep its title, its layout and every section he did not ask about.
- In a chat, `ash_page_rebuild {page (title or id), prompt}` does the same. If he wants a page like one he keeps,
  copy its shape instead of inventing a new one.
- The ready-made pages (**Agents**, **Needs you**, **Being built**, **Projects**) can be rebuilt too. Do not build a
  page that repeats one of them.

## 2. Blocks or bespoke
- Use the hub's blocks (`status`, `list`, `chart`, `barlist`, `note`, `calendar`) when they can show it: 1 to 12
  blocks, each with a title, and the same three status colours. `hub.block(kind, data)` draws them inside a bespoke
  page too.
- Go bespoke (`html`, `css`, `js`, `permissions`) only when the blocks can't do what he asked. Bespoke runs in a
  sandbox: no storage, no cookies, no parent page, and no internet of its own.

## 3. Keep the asks honest
- List every call the page makes in `permissions`. One it does not list is refused in plain words, and one it lists
  but does not use is a reason not to allow it.
- Reads: `agents.read` (agents, chats, delegated work), `jobs.read`, `needs.read`, `rooms.read`,
  `sessions.read` (the hub's own chats, behind `agents.read`), `tasks.read`, `project.read`, `settings.read`.
- Taps: `agents.answer`, `agents.pick`, `agents.message`, `agents.stop`, `chats.open`. Call them only inside a click
  handler: a page never acts by itself, and a preview's buttons wait for Keep and allow.
- Writes: `project.write` renames a project through the hub's own store and lands as a Bot changes row Ash can undo.
  The other writes are declared but not connected, so do not build on them.
- Never ask for a key. A page can't reach the network and can never hold one. `tasks.write`, `mono.run`,
  `automation.run` and `settings.write` have nothing behind them yet; say so instead of wiring a button that fails.

## 4. A web source is Ash's to connect
- A page reads the web only through the app: `await hub.call("http.fetch", { url, method, body, accept, contentType })`,
  with the method GET, HEAD, POST, PUT, PATCH or DELETE. It reads an address only if Ash connected that source on the
  page itself (Web sources → Connect); anything else comes back as a plain refusal, so show it, never an empty table.
- A connect is one origin plus a path, and it is a Bot changes row he can undo. A source that needs a token has the
  token entered there: the app keeps it in the Keychain and adds it to the request. Never put a token, a key or an
  address-with-a-password in the page's code, and never ask him to paste one into the page.
- The response is `{status, type, body, url}`; `body` is text. Check `status` before drawing, and say what failed.

## 5. Look like the hub
- Style every colour, surface, border and shadow with the theme tokens (`--color-content`, `--color-surface`,
  `--color-surface-raised`, `--color-surface-ring`, `--color-stroke`, `--color-theme-accent`). No hex, no `rgb()`,
  and no red, amber or green outside a real status.
- Small text is `var(--color-content)` at 60% or more. The design check blocks a page below 4.5:1 contrast in any
  shipped scheme, so check Glass, Graphite and Dusk.
- The frame draws the page's title, so do not repeat it as an `h1`. A section with nothing yet gets its own grey
  line ("Nothing waiting on you"), not an empty card.
- Real data only. No example or made-up rows; an empty page says so and is still useful.

## 6. Hand it back
- Say what changed in one line and what he will see. The new version shows on the page as "New version from …
  · See it"; he taps **Use this version** (or **Use it and allow** when it asks for something new) or **Throw away**.
- If he keeps it, it takes the place of the old page and keeps everything he had already allowed that it still asks
  for. You do not need him to approve anything else.
