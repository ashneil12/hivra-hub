# Pages build contract

How a Mono builds a Page for Ash. The app side is done. The backend implements one call.

Code: `src/features/pages/model/` (`buildPage.ts`, `pageSpec.ts`, `designCheck.ts`, `bridge.ts`, `sandbox.ts`).

## 1. The call

```ts
buildPage({ projectId, monoId, prompt }): Promise<BuildPageResult>
```

- **Who may call it:** only a seated Mono, meaning one on the Monos roster (CoS, Projects Manager, frank, Alfred, the Leads, or anything Ash added).
  - Temporary workers are turned away in the app before anything is sent, with the reason "Only a seated Mono can build pages. Temporary workers can't."
  - The backend must enforce the same rule.
- **Transport:** the hub plugin, using the same route as every other `ash-hub-*` call:
  `transport.call("ash-hub-build-page", { projectId, monoId, prompt })`
- **The backend's job:**
  1. Run that Mono with the system instructions in section 5.
  2. Return a `PageSpec` (section 2) as the call's `result`.
- **Waiting:** the app sends `wait: 30` (seconds Ash OS may wait for the build; hub.rs adds it to the call's 15 s).
  A build not done by then answers "<Mono> is still building this page. Press Try again…"; the app then asks again by
  itself (the same request joins the same build) for up to `BUILD_TOTAL_SECONDS` (240 s) before it shows the
  still-building card; Try again sends the same request and collects the finished page. The answer carries
  `pageId` (the record's preview); Keep sends `ash-hub-page-update {pageId, kept: true, permissions}`.
- **Where kept pages live:** Ash OS's record (`ash-hub-pages`, `-page-update`, `-page-remove`), not localStorage.
- **Errors:** reject with `{ kind, message }` as `hub.rs` already does.
  - `unreachable`, `timeout`, `unauthorized` or `refused`: the app shows **Not connected yet**.
  - Anything else: the app shows the message with Try again.
- **Results the app shows:**
  - `ready`: the preview, plus any warnings.
  - `turned-down`: a plain reason, styled like the existing turned-down row.
  - `not-connected`: the Not connected yet card.
  - `error`: the message with Try again.
- **Dev only:** the old keyword stub runs when `localStorage["monocode:pages-dev-stub"] = "1"`. It never runs otherwise.

## 2. What comes back: `PageSpec`

The answer is one of two kinds. The JSON schema is `PAGE_SPEC_SCHEMA` in `pageSpec.ts`. `validatePageSpec` checks every field, and anything off comes back to the Mono as one plain reason.

```json
{ "kind": "blocks", "title": "EXO · Bugs and fixes", "blocks": [ { "kind": "status", "title": "Status", "state": "bad", "line": "2 bugs still open", "detail": "…" } ] }
```

```json
{ "kind": "bespoke", "title": "Hivra growth room", "html": "<div>…</div>", "css": "…", "js": "…", "permissions": ["tasks.read", "keys.read:Anthropic"] }
```

**Block kinds and their fields** (state is `ok`, `warn` or `bad`):
- `status`: state, line, detail
- `list`: rows of { text, state, label }
- `chart`: bars of { label, value }
- `barlist`: rows of { label, value }. This block is restyled from Tremor's BarList (tremorlabs/tremor, Apache-2.0).
- `note`: text
- `calendar`: month, firstWeekday (0 = Monday), days (28 to 31), marked of { day, text }

A blocks page has 1 to 12 blocks, and each block has a title. Bundled blocks are a shortcut, not a limit: a Mono may build a bespoke page instead.

## 3. Bespoke pages: the sandbox

A bespoke page renders in an `<iframe sandbox="allow-scripts" srcdoc=…>`.
- **No `allow-same-origin`**, so it has no storage, cookies, parent DOM, IPC, Tauri or keys of its own.
- **Strict CSP:** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'`. It has no network access and can't load outside scripts.
- **Theme tokens** are injected as CSS variables on `:root`: `--color-background-base`, `--color-content`, `--color-surface`, `--color-surface-raised`, `--color-surface-ring`, `--color-stroke`, `--color-theme-accent`, `--color-status-ok|warn|bad`, `--font-sans`. Pages follow the active theme and scheme by default.
- **Helper library** (`window.hub`), injected into every page:
  - `hub.call(name, args)` returns a Promise. It is a call through the bridge.
  - `hub.watch(name, [args], onData, [onError])` receives live data as it changes; it returns a stop function.
  - `hub.onData(fn)` receives every push (`fn(data, name)`).
  - `hub.block(kind, data)` returns a bundled block element (`status`, `barlist`, `note`) already styled with the tokens.
- **The bridge:** postMessage is the only way out. The host answers only messages from that frame.

## 4. Permissions: by ask

- A bespoke page lists what it needs in `permissions`:

| Permission | What the preview says |
|---|---|
| `tasks.read` | Read this project's tasks |
| `tasks.write` | Add and change tasks |
| `project.read` | Read this project's files and status |
| `project.write` | Write to this project |
| `mono.run` | Ask a Mono to run work |
| `automation.run` | Run an automation |
| `settings.read` | Read your settings |
| `settings.write` | Change your settings |
| `keys.read:<Name>` | Names one key, e.g. `keys.read:Anthropic` |
| `agents.read` | See your agents, what each is doing and the work they handed out |
| `jobs.read` | See what's being built |
| `needs.read` | See what's waiting on you |
| `rooms.read` | Read your rooms' messages |
| `agents.answer` | Answer an agent's question when you tap |
| `agents.pick` | Take an agent's suggested answer when you tap |
| `agents.message` | Send a Mono a message when you tap |
| `agents.stop` | Stop an agent's work when you tap |
| `chats.open` | Open a chat when you tap |

- **Key asks** sit in their own glass card above the list: **Reads your keys**, followed by each key's name. When a key is asked for, **Keep and allow** stays disabled for about one second after the card appears, so a fast click can't approve keys by accident.
- **Keep and allow** approves every ask. The approved list is stored with the page.
- **Bridge rules:** it answers only approved asks. Anything else is refused in plain words, e.g. "This page didn't ask to read your OpenAI key, so it can't."
- **Undo** (Settings → Changes → Bot changes) removes the page and revokes its permissions. Redo puts both back.
- **Two absolute walls** that can never be asked for:
  1. Adding, seating, renaming or deleting Monos.
  2. Anything that leaves the sandbox: direct IPC or Tauri. Everything goes through the bridge.

  A spec asking for either is turned down.
- **Limits line** on the empty, preview and kept screens: "This can't change the app's core screens, the sidebar, settings, keys or Monos." A page reaches settings or keys only through asks Ash approved.
- **Wired:** the agent capabilities below ("Connected pages"). The older ones (`tasks.*`, `project.*`, `mono.run`,
  `automation.run`, `settings.*`, `keys.read:*`) still answer "Not connected yet".

## 4b. Connected pages (live data and taps)

Code: `pageData.ts` (what a page reads), `pageSources.ts` (where it comes from, and its changes), `pageActions.ts`
(the taps), `pageBridgeHost.ts` (one frame's side of the bridge).

- **Reads** (`hub.call(name, args)` once, or `hub.watch(name, [args], onData, [onError])` live; `watch` returns a stop
  function). Live means pushed as it changes, never polled: a burst of changes is one push, the same data is never sent
  twice, and Undo ends the watch (`onError` hears why).
  - `agents.read` → `{agents, counts}`. Each agent (the Monos roster: the team, the Leads, any Mono Ash added):
    `{id, name, role: lead|team|mono, projects, state: asking|stuck|working|paused|idle, doing, reason?, since, chatId?,
    question?, workers, jobs, waitingOn}`. `workers` is the work it handed out, nested:
    `{id, title, state: asking|stuck|working|failed|done|stopped, doing, reason?, chatId, startedAt, since, endedAt?,
    question?, workers}`. A `question` is `{chatId? | needId?, text, pick?, options?, redLine, askedAt?, canAnswer}`.
    Stuck: a busy chat with no new word for 10 minutes, a worker whose chat ended without reporting (2 minutes), a usage
    limit, or a stuck Being built job.
  - `jobs.read` → `{jobs: [{id, projectId, projectName, title, agentId, agentName, state, reason?, startedAt?, lastActiveAt?, finishedAt?}]}`.
  - `needs.read` → `{needs: [{id, projectId, projectName, title, why, action, isQuestion, since?}], waiting: [{chatId, chatName, projectId, projectName, agentId, question, pick?, redLine, askedAt}]}`.
  - `rooms.read {projectId?, limit?}` → `{rooms: [{id, projectId, name, members, typing?, conversation: {id, title, when, messages: [{id, from, text}]}}]}`.
- **Taps** (`await hub.call(name, args)` inside a click handler) go through the same paths as Ash's own taps:
  - `agents.answer {chatId | needId, text}`: a chat waiting on Ash (Waiting on you's answer), a worker's live question
    (the answer in its own chat), or an Ash OS question (`ash-hub-answer`).
  - `agents.pick {chatId | needId}`: the agent's suggested answer (Take the pick; `quick: "agree"` for Ash OS).
  - `agents.message {agentId | chatId, text}`: the composer's send into that chat (it steers or queues mid-turn).
  - `agents.stop {workerId | agentId | chatId}`: the delegation tree's own Stop (it and everything it handed out).
  - `chats.open {workerId | agentId | chatId}`: the app's own Open.
  - Words a page sends end with "(sent from the <title> page)"; the page shows what it did under itself
    ("Stopped “Fix the save bug” · from the Agents page · 2m ago").
- **Rules:** a tap runs only on a kept page, only with its permission approved, and only while Ash's tap inside the
  page is fresh (the browser's user activation): a page can never act by itself. A preview may read the live data it
  asked for (so Ash sees what he keeps); its buttons and every other ask wait for Keep and allow.
- **Size:** the helper tells the host the page's height and the frame follows it (160 to 4000 px).
- **Navigation:** a frame that loads anything but its own page is cut off and given a fresh frame (the app's CSP
  `frame-src` already refuses the trip).

## 5. Design check (bespoke pages, before the preview)

`checkBespokePage` runs on every bespoke page.
- **Blocks the page:** small text below **4.5:1** contrast in any shipped scheme (Glass, Graphite, Dusk).
  - It is measured from each text colour the page declares (`var(--color-content)`, `color-mix(… var(--color-content) N% …)`, or a literal colour, times `opacity`). It is drawn over the raised surface, which is the worst case.
  - A blocked page gets no preview. It goes back to the Mono with the plain reason, shown like the turned-down row.
- **Warnings** (the preview still shows, and Keep and allow still works):
  - Own colours instead of theme tokens: any hex, `rgb()` or `hsl()` value.
  - Red, amber or green (`--color-status-*`) used outside status elements.

  Each warning has plain words and a **Fix it** button that sends the issue back to the Mono.

## 6. What the Mono is told (system instructions)

> You are building a Page for Ash inside MonoCode Hub, for project {projectName}. Ash asked: "{prompt}".
> Answer with ONE JSON object and nothing else, matching the PageSpec schema:
> - Prefer `{"kind":"blocks", …}` using the hub's blocks: status, list, chart, barlist, note, calendar. Use a bespoke page (`{"kind":"bespoke","html","css","js","permissions"}`) only when the blocks can't do what Ash asked.
> - Bespoke pages run in a sandbox with no network. Style them ONLY with the CSS variables --color-content, --color-surface, --color-surface-raised, --color-surface-ring, --color-stroke, --color-theme-accent and --font-sans. Draw small text with var(--color-content) at 60% or more. Red, amber and green (--color-status-ok/warn/bad) mean status only.
> - Get data only with `await hub.call(name, args)`, and list every capability you call in `permissions` (e.g. "tasks.read", "keys.read:Anthropic"). You may embed hub blocks with `hub.block(kind, data)`.
> - Never ask to add, seat, rename or delete Monos, and never try to reach the app directly.
> - Plain words for a non-developer. Title at most 80 characters. Use the project's real data only; a block with nothing real yet goes in empty (no rows or bars) and shows "Nothing here yet". The app turns down example or made-up data.

Ash OS also tells the Mono how to connect a page (section 4b: `hub.watch`, the data's shape, taps only inside a click
handler, list every read and tap in `permissions`), and, for a Rebuild, the page as it is now (`ashos/pages.py`,
`PAGE_RULES` and `REBUILD_RULES`).

## Ready-made pages

`readyPages.ts`. Pages offers them under **Ready-made** (in the list, and on the empty screen) until one is kept. **Add**
shows its preview with what it asks, and **Keep and allow** keeps it like any page (by "Ready-made", on Today's pages).
- **Agents**: every agent and what it is doing; the stuck and asking ones (agents and the work they handed out, at any
  depth) on top with **Take it**, **Answer**, **Open** and **Stop**; then Working (with each agent's recent work) and Idle
  (with **Message**). It watches `agents.read` and uses only the taps, so it is the pattern for a Mono's own connected
  page, and Rebuild changes it from Ash's words like any other.

## Rebuild (change a kept page from Ash's words)

- **Rebuild** beside the pin on a kept page: Ash says what should change ("add a column for stuck time") and picks the
  Mono (the one that built it by default). `rebuildPage({pageId, monoId, prompt})` sends `ash-hub-build-page` with the
  page's `pageId`; the Mono changes the page as it is now. The answer carries `replaces`.
- A Mono can do the same from Ash's words in its own chat: the ash-os tool `ash_page_rebuild {page (title or id), prompt}`.
- Either way the new version **waits on the page** (`newVersion` in `ash-hub-pages`; "New version from frank: “…” · See
  it"). The page runs as it is until Ash taps:
  - **Use this version** (`ash-hub-page-update {pageId, useVersion}`): the same page (pin, place on Today) takes the new
    code and keeps what he allowed that it still asks for. If the new version asks for something new, the button is
    **Use it and allow** (it sends `permissions`), with the key delay when a key is newly asked for.
  - **Throw away** (`dropVersion`): the page stays as it was.
- The new version previews like a new page: dashed border, "Preview" watermark, live data it asked to read, no taps.

## Pinning

The answer may carry `pin: true` (next to the spec's own fields). That pins the page to the sidebar once Ash keeps it, marked "pinned by {Mono}". Ash can unpin it, or pin any page himself, from the Pages list.

## No manual builder

New page is only a prompt box. The bundled blocks (status, list, chart, barlist, note, calendar) are helpers the Mono builds with. Ash never picks them himself.

## The page kit (every built page)

The frame adds a small kit after the page's own code (`sandbox.ts`), so every built page gets it without the Mono
writing it:

- The app's header already shows the page's title, so the page's own first `h1` is hidden (no title twice).
- A `section` that has only its heading gets one grey line instead of a bare heading: "Nothing waiting on you" under a
  Needs you heading, "No one else right now" under Everyone else, "Nothing here right now" otherwise. A section can name
  its own line with `data-empty="…"`. The line goes as soon as real content arrives.
- Section headings read in sentence case at a medium weight, never bold caps.
