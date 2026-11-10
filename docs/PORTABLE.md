# Phase 5: export and import (portable)

Ash, 19 Oct: "I can import and export my entire setup, plus memories, etc. I can just basically use whatever coding
engine I want" and "the overall workspace should also be able to be imported and exported".

Settings → **Export and import**. Export writes one `.tar.gz` or a folder; Import reads either (or a v1 `.json`), shows a
preview, and restores only what is ticked.

## The export (format `monocode-hub-export`, version 2)

```
manifest.json            format, version, createdAt, the build that made it, what was ticked (parts), counts,
                         secretsRemoved, notes (what was left out and why), every file with its bytes and SHA-256
setup/                   always. Written by the webview (src/features/portable/model/setupDoc.ts)
  setup.json             format monocode-hub-setup, version 2: projects (registry fields + template), Ash's project
                         names/icons/order, custom models (metadata, no key), settings and themes, the Mono ids
  projects/<id>.json     per project (and "today"): its teams (group chats: name, members), Monos, Lead, connectors, Pages
  connectors.json        [{id, name, projectId, where: mac|composio|none, loginLivesIn}]  never a login
  monos/<id>/            mono.json (look, projects + project ids, team, engine {harness, model}, optional roleLabel:
                         Ash's own sidebar role line, "" when he cleared it, absent for the built-in one), SOUL.md, habits.json,
                         sheet.md (for people), skills.json (each skill and where it lived), and only with memory
                         ticked MEMORY.md + memory/<note>.md
memory/                  only if ticked. Ash OS project memory: <project>/**.md for each folder with a MEMORY.md (the
                         global layer `ash` among them; the dump ledger `inbox` is not memory), and with "history"
                         <project>.git.bundle
workspace/               only if ticked. Written by Rust (src-tauri/src/portable.rs)
  sessions/<id>.json     one chat: title, folder, dates, flags, engine {harness, model, modelSettings, runtimeMode},
                         providerTranscript {harness, providerSessionId, path on the Mac that made it}, blocks
  notes.json             notes and artifacts (every column), note-assets/<id>/ their pictures
  automations.json       definitions; reminders.json; delegations.json (no mirror fields)
  hub/group-chats.json   the group chats with their conversations (webview)
```

The archive is the same tree under one top folder. Nothing in it is a secret:
- Keychain items are never read. Connectors say where the login lived; custom models carry no key.
- One pattern list (`src/features/portable/model/secretPatterns.json`) is used by the webview and Rust. The webview
  scrubs the setup files before they cross; Rust scrubs everything it writes, then scans the finished export again and
  refuses (leaving nothing behind) on any hit. A memory folder whose git history has a secret in any commit goes without
  its history (the manifest notes say so). Settings whose name or value looks like a secret stay home.
- A file without secrets goes byte for byte as it was.
- Note pictures go the same way they come in: plain files up to the size a note takes (20 MB), never through a link. A
  `note-assets` folder, or a note's folder in it, that is a link is not followed (the manifest notes say so), and a note
  doesn't take a picture that is a link either (`notes_save_image`).

## Import

1. **Read** (`portable_inspect`): a folder, `.tar.gz` (unpacked to a scratch folder: links, devices and paths that climb
   out are refused) or v1 `.json`. Every listed file must match its SHA-256; a newer format is refused in plain words.
   What the manifest lists is checked before a byte is read: at most 500,000 files, each with a path inside the export, a
   size, and no more than its kind may be (a note's picture 20 MB, a memory folder's history bundle 1 GB, any other
   text or JSON file 64 MB), all of them together no more than 8 GB, and none listed twice (`a/./b`, `a//b` and `A/B`
   are one file). The export writes by the same limits. Then each listed file, and `manifest.json` itself (64 MB at
   most), is read through one reader (`plain_file.rs`): a link, a pipe or a device is refused unread (a listed link to
   `/dev/urandom` can't fill the memory, a pipe can't hang the open), no more bytes are read than the manifest says,
   and each listed file's folder must really be inside the export (a link above it is refused, and a picked folder
   that holds the export only as a link isn't taken for it). A file the manifest doesn't list is never read, the fixed
   `workspace/*.json` names included; each later read of a listed file hashes the bytes it uses, and one that changed
   since is left out with a line in the report. A single `.json` is read the same way. Inspect holds at most 128 MB of
   the webview's files. An archive is unpacked against its byte budget by the size the tar crate really copies (a PAX
   size overrides the header's) and the bytes really written.
2. **Preview** (`importPlan.ts`): for every item, New / Already here / Differs, and clashes by id and by name (a project
   or Mono or model called the same). New things are ticked; things already here are left alone; Differs keeps Ash's.
3. **Restore** only adds:
   - Projects: a new one is registered with Ash OS (`ash-hub-project-create`, adopting its folder if it is on this Mac,
     never making one), else kept on this Mac's list. Templates and project names/icons only where Ash has none.
   - Monos never seat themselves: a new one waits for Ash's OK (Monos list), and OK seats it with its look, projects
     (mapped to this Mac's folders by project id) and engine, writing only files that aren't there. A Mono already here
     gains missing files and projects; its own soul is replaced only if Ash ticks "use the file's".
   - Teams, connectors (sign in again), Pages (no permissions), models (enter the key again), settings (missing ones;
     the differing ones only if ticked).
   - Memory: missing files are written, identical ones skipped, differing ones kept (or the file's added beside as
     `<name>.imported.md` if ticked). A folder that isn't here yet comes back with its history from the bundle. git is
     never handed the bundle's path in the export (`git clone` decides for itself what a path means: a gitfile there
     clones the repository it names, and `<path>.git` beside it is cloned instead): the listed bytes are copied, hashed
     as they go, into a private folder as its only file, checked to begin `# v2 git bundle` or `# v3 git bundle`, and
     cloned from there. The folder is removed afterwards, also on an error.
   - Workspace: new chats, notes, automations (**paused**), reminders (an overdue one comes back done), delegations
     (**history only**: open ones settle as cancelled, delivery disposed, nothing mirrored to Ash OS again). A chat or
     note already here and different is kept; ticked, the file's comes in as a copy with a new id.
   - A note's pictures (`workspace/note-assets/<id>/`) come in only as files the manifest lists, as the very bytes that
     hash as listed, never through a link (the picture, its folder, `note-assets` or `workspace`), and never over a file
     already here. Anything else in that folder is left out and counted in the report (`noteAssetsSkipped`, with a line
     in its notes). A folder export can hold links; an archive can't (unpacking refuses them). A picture's name is
     exactly one plain file name: one with a folder in it is left out.
   - A provider session id is kept only where it can resume: the daily app, a Claude chat, its transcript on this Mac.

**Engine-agnostic.** Every Mono and every chat names its engine. A Mono with an engine starts new conversations on it
(`monoWorkspace.ts`); an engine this build doesn't know falls back to the default.

**Dev copies.** Memory lives in the slot's own `<data>/agent-memory`; `npm run hub:dev -- --memory <dir>` points Export at
another folder (it sets `MONOCODE_HUB_MEMORY_ROOT`, which hub:dev otherwise strips). A dev copy never writes into
`~/agent-memory`, `~/.claude` or the daily data folder, and never keeps a provider session id.

## What does not travel (A10 check, 21 Oct)

Ash, 21 Oct 20:40: "transferable" means the whole setup, Monos and all, moves into a fresh MonoCode. Checked against
the code: projects, Monos (soul, habits, skills list, engine, look, role label; memory when ticked), teams/rooms and
their conversations (workspace ticked), connectors (sign in again), Pages, custom models (key again), settings and
themes, project memory, chats, notes, automations, reminders and delegation history all travel. Added on 21 Oct:
`monocode:hub-user-name` (what the team calls the user) and `monocode:stall-minutes`. Deleted Monos stay deleted:
`monocode:mono-team-removed-by-user` travels and is merged (never replaced) on import; a default-team Mono a fresh
copy seeded on first launch (never talked to, not in the export) is taken back off, and an older export's deleted
Monos come unticked (importPlan.ts; test in portableRoundTrip.test.ts).
- Per-project worker limits ("Workers at once", heavy tests): carried as `monocode.workerLimits.v1`. They live in the
  app's Rust store (worker_queue.rs worker_limits/worker_heavy), so the export writes them from the worker pool's own
  copy and the import puts them back through `setWorkerLimits`, never by writing the key (its one-time storage import
  has already run). In "missing" mode a project whose limits are already set here keeps them.
- A Mono's own team (`monocode:mono-teams`): carried by Mono id, with the day it was first made. The folder stays
  machine-local — the import makes this Mac's own (`<app data>/mono-teams/<id>`) rather than taking another Mac's path,
  and only for a Mono that is here or coming in ("missing" mode keeps a team already here). What the old folder held is
  not copied.
Still not carried:
- Keys and logins (by design): Claude/Grok sign-ins, custom-model keys (DeepSeek, xAI), connector logins.
- Which chats are a project's coding team (`monocode:coding-team-chats`): not exported, but re-noted on a chat's next
  turn in the project's folder, so it heals itself.
- Machine paths (provider binaries, project folders: mapped by project id on import).

## Tests

- Rust (`src-tauri/src/portable/tests.rs`): round trip into an empty data folder for both forms (same chats incl. a
  Mono's indexed transcript, notes and pictures, automations, reminders, delegations, memory files and history, minus
  secrets), planted-secret scan of every file, conflicts previewed and never overwritten, ticks respected, dev-copy
  rules, a secret in old history, newer/damaged/escaping exports refused, v1 recognised.
- Webview (`src/features/portable/**`): setup round trip into fresh stores, no secret in the setup files, conflicts and
  "use the file's", ticks, v1 import, the Settings page sends exactly what is ticked.
