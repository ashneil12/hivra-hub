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

## Import

1. **Read** (`portable_inspect`): a folder, `.tar.gz` (unpacked to a scratch folder: links, devices and paths that climb
   out are refused) or v1 `.json`. Every listed file must match its SHA-256; a newer format is refused in plain words.
2. **Preview** (`importPlan.ts`): for every item, New / Already here / Differs, and clashes by id and by name (a project
   or Mono or model called the same). New things are ticked; things already here are left alone; Differs keeps Ash's.
3. **Restore** only adds:
   - Projects: a new one is registered with Ash OS (`ash-hub-project-create`), else kept on this Mac's list. They are
     registered before the workspace, so the chats are judged against them. The folder a file names for a project is
     adopted only when it was ticked in "Project folders" (every one starts unticked; "Tick all" is for a restore of
     your own), it is on this Mac, and Rust doesn't refuse it (see Folders below), never making one; otherwise the
     project comes in without a code folder. Templates and project names/icons only where Ash has none.
   - Monos never seat themselves: a new one waits for Ash's OK (Monos list), and OK seats it with its look, projects
     (mapped to this Mac's folders by project id) and engine, writing only files that aren't there. A Mono already here
     gains missing files and projects; its own soul is replaced only if Ash ticks "use the file's".
   - Teams, connectors (sign in again), Pages (no permissions), models (enter the key again), settings (missing ones;
     the differing ones only if ticked).
   - Memory: missing files are written, identical ones skipped, differing ones kept (or the file's added beside as
     `<name>.imported.md` if ticked). A folder that isn't here yet comes back with its history from the bundle.
   - Workspace: new chats, notes, automations (**paused**), reminders (an overdue one comes back done), delegations
     (**history only**: open ones settle as cancelled, delivery disposed, nothing mirrored to Ash OS again). A chat or
     note already here and different is kept; ticked, the file's comes in as a copy with a new id.
   - A provider session id is kept only where it can resume: the daily app, a Claude chat, its transcript on this Mac.
   - **Folders.** An export is a file anyone can write, and a chat's folder is where its agent, git, checkpoints and
     terminals run, so none is taken on trust (`src-tauri/src/portable/folders.rs`). A chat's folder (and worktree)
     stays only when it is a real folder on this Mac, written as a full path, that sits inside a project this copy
     already has, both sides resolved first with links followed (a link in a project that points out is refused, and a
     folder that only shares a project's prefix is not inside it). The projects are the ones in the app's own record
     (`hub_local_docs`, key `projects`), the folders the project rail lists (the window passes them in
     `workspace.knownFolders`; the rail lives in the webview's storage, the record in the database Rust holds), and the
     Monos' own folders (inside `<monos home>` or `<app data>/mono-teams`). The home folder and `/` never count as a
     project, whatever a record says. A worktree also stays when `git worktree list` names it for one of those
     projects. Otherwise the folder is cleared and so is the chat's worktree: the chat opens with no folder, shows
     "Choose a project folder for this chat first." with a folder picker, and starts nothing until one is chosen. The
     report counts those chats (`foldersCleared`) and the automations that lost a folder the same way
     (`automationFoldersCleared`, they also come back paused). A chat with no folder is listed in the sidebar's
     "Needs a folder" group (`session_list_folderless`) until it gets one.
   - **Project folders.** The preview lists every project folder the file wants to register, each unticked (the file
     names them, so only a tick adopts one). Whatever is ticked, Rust refuses a folder that is `/`, `/Volumes`, the
     home folder or any folder holding it, the app's own data folder, a folder holding it or one inside it, a relative
     path, or one that isn't a folder here (`refused_project_folder`, asked through `portable_project_folder_checks`
     in the preview and again as the import registers; if it can't be asked, nothing is adopted). The same list keeps
     such a folder from vouching for chats even if a project record has it. Because the ticked projects are
     registered first, a restore on a fresh Mac keeps its chats' folders; an unticked project's chats come in with none.
   - **Paths in tool rows.** A tool row's `paths` and `preview.path`, and an approval's `call.paths`, feed the checkpoint
     calls, so only paths inside the chat's kept folder (or worktree) stay, `..` and links resolved; the rest are
     dropped (`toolPathsDropped`). A chat with no kept folder keeps none.
   - **Older imports.** A chat imported before 0.16.13 keeps its old attachment paths, and its old folder: Copy and Edit
     or resend still read the attachment paths, and nothing here rewrites a chat already in the database.

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
- Machine paths (provider binaries, project folders: mapped by project id on import). A new project's folder is
  adopted only when ticked in the preview and not refused by Rust (see "Project folders" above); a Mono's own project
  folder is likewise not taken from a file when Rust refuses it.

## Tests

- Rust folder tests (`src-tauri/src/portable/tests.rs`, "the folder an imported chat may keep"): a crafted export
  naming `/tmp/elsewhere`, a link inside a project that points out, a same-prefix sibling, a missing folder, `..`, a
  relative path, `~` and an empty one are all cleared; a project subfolder and the project itself are kept; worktrees,
  the rail's folders, the home folder and the Monos' folders; automations; tool-row paths.
- Rust (`src-tauri/src/portable/tests.rs`): round trip into an empty data folder for both forms (same chats incl. a
  Mono's indexed transcript, notes and pictures, automations, reminders, delegations, memory files and history, minus
  secrets), planted-secret scan of every file, conflicts previewed and never overwritten, ticks respected, dev-copy
  rules, a secret in old history, newer/damaged/escaping exports refused, v1 recognised.
- Webview (`src/features/portable/**`): setup round trip into fresh stores, no secret in the setup files, conflicts and
  "use the file's", ticks, v1 import, the Settings page sends exactly what is ticked.
