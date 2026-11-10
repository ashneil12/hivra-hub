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
secrets/                 written by Rust (src-tauri/src/secrets): the vault's index, never a value
  index.json             [{name, scope, label, last4, createdAt}]
```

The archive is the same tree under one top folder. Nothing in it is a secret:
- Keychain items are never read. Connectors say where the login lived; custom models carry no key.
- One pattern list (`src/features/portable/model/secretPatterns.json`) is used by the webview and Rust. The webview
  scrubs the setup files before they cross; Rust scrubs everything it writes, then scans the finished export again and
  refuses (leaving nothing behind) on any hit. A memory folder whose git history has a secret in any commit goes without
  its history (the manifest notes say so). Settings whose name or value looks like a secret stay home.
- A file without secrets goes byte for byte as it was.
- Hivra WP-92: `secrets/index.json` holds each secret's name, scope, label, last four characters and date, and nothing else; the value stays in your Mac's keychain and never enters an export. An import brings those rows back in a "needs its value" state, with no grants and no `.env` records, so each one is usable only once you type its value again.
- Note pictures go the same way they come in: plain files up to the size a note takes (20 MB), never through a link. A
  `note-assets` folder, or a note's folder in it, that is a link is not followed (the manifest notes say so), and a note
  doesn't take a picture that is a link either (`notes_save_image`).

## Import

1. **Read** (`portable_inspect`): a folder, `.tar.gz` (unpacked to a scratch folder: links, devices and paths that climb
   out are refused) or v1 `.json`. Every listed file must match its SHA-256; a newer format is refused in plain words.
   What the manifest lists is checked before a byte is read: at most 500,000 files, each with a path inside the export
   and a size, all of them together no more than 8 GB, and none listed twice (`a/./b`, `a//b` and `A/B` are one file; a
   disk that tells `A.md` from `a.md` apart can't have both in an export, a limit of this check). A file bigger than its
   kind (a note's picture 20 MB, a memory folder's history bundle 1 GB, any other text or JSON file 512 MB: a chat holds
   every tool output, and Claude's own transcript of a long one passes 150 MB), or that would take the webview's files
   (`setup/`, `workspace/hub/`) past the 256 MB Inspect holds, is not a reason to refuse the lot: it is left out, never
   hashed or read, and the report says so. The export keeps to the same rule (one function, `left_out_reason`) and to the
   same totals, so it never writes what an import turns away; too many files, too many bytes or a manifest past 64 MB
   stops the export with a plain line instead. Then each listed file, and `manifest.json` itself (64 MB at most), is
   read through one reader (`plain_file.rs`): a link, a pipe or a device is refused unread (a listed link to
   `/dev/urandom` can't fill the memory, a pipe can't hang the open), no more bytes are read than the manifest says, and
   each listed file's folder must really be inside the export (a link above it is refused, and a picked folder that
   holds the export only as a link isn't taken for it). A file the manifest doesn't list is never read, the fixed
   `workspace/*.json` names included; each later read of a listed file hashes the bytes it uses, and one that changed
   since is left out with a line in the report. A single `.json` is read the same way. An archive is unpacked, into a
   folder only this user can open, against its byte budget by the size the tar crate really copies (a PAX size
   overrides the header's) and the bytes really written.
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
     `<name>.imported.md` if ticked). A folder that isn't here yet comes back with its history from the bundle. git is
     never handed the bundle's path in the export (`git clone` decides for itself what a path means: a gitfile there
     clones the repository it names, and `<path>.git` beside it is cloned instead): the listed bytes are copied, hashed
     as they go, into a private folder as its only file, checked to begin `# v2 git bundle` or `# v3 git bundle`, and
     cloned from there. The folder is removed afterwards, also on an error. Every git command of the restore runs with
     the machine's own git configuration, attributes and hooks switched off and `GIT_LFS_SKIP_SMUDGE=1` (a filter in
     that configuration, git-lfs on a Mac that has it, would otherwise run at checkout on paths the history chose), and
     a `.gitattributes`, `.lfsconfig` or `.gitmodules` in the history is not checked out (the report says which).
   - Workspace: new chats, notes, automations (**paused**), reminders (an overdue one comes back done), delegations
     (**history only**: open ones settle as cancelled, delivery disposed, nothing mirrored to Ash OS again). A chat or
     note already here and different is kept; ticked, the file's comes in as a copy with a new id.
   - A note's pictures (`workspace/note-assets/<id>/`) come in only as files the manifest lists, as the very bytes that
     hash as listed, never through a link (the picture, its folder, `note-assets` or `workspace`), and never over a file
     already here. Anything else in that folder is left out and counted in the report (`noteAssetsSkipped`, with a line
     in its notes). A folder export can hold links; an archive can't (unpacking refuses them). A picture's name is
     exactly one plain file name: one with a folder in it is left out.
   - A provider session id is kept only where it can resume: the daily app, a Claude chat, its transcript on this Mac.
   - **No file path from the file is kept.** Paths in an export name files on the Mac that made it, or were written by
     hand: never files of this one. In every imported chat (side threads and Mono transcripts included) a generated
     image keeps its name, caption and size with an empty path, an attachment keeps its name and kind and loses its
     path, and a room message's attachments are replaced by a line naming them. The chat shows them as "not on this
     Mac". The import preview compares chats without paths, so a chat that came in from a file still reads as "already
     here". The report says how many paths were left out.
   - **Folders.** An export is a file anyone can write, and a chat's folder is where its agent, git, checkpoints and
     terminals run, so none is taken on trust (`src-tauri/src/portable/folders.rs`). It is an allow-list:
     a chat's (or automation's) folder and worktree stay only when the folder is a real folder on this Mac, written as
     a full path, **strictly inside the home folder** (both sides resolved, links followed, so `/System/Volumes/Data`,
     `/private`, `/Users/Shared`, another user's home and every other alias fail), with **no hidden part** (`.ssh`,
     `.claude`, `.git`), not in `~/Library`, not the memory root or the app's data folder or a folder holding either,
     and inside a project this copy has: the app's own record (`hub_local_docs`, key `projects`), the folders the
     project rail lists (the window passes them in `workspace.knownFolders`), each passing the same test, or the
     folder of a Mono seated here (`<monos home>/<id>`, `<app data>/mono-teams/<id>`, for the ids the window passes in
     `workspace.knownMonos`; never built from what is on disk, so a memory folder named `monos` can't make
     `monos/evil` a Mono's). A folder from another Mac is mapped to this Mac's own by id before it is judged: a file's
     `…/mono-teams/<id>` or `…/monos/<id>` to that Mono's folder, and a project's folder to this Mac's folder for the
     same project id (`workspace.folderMap`, so another user name or home still finds its projects); the same
     allow-list judges the result. The rules load after the memory is written, and a chat is not kept where this
     import wrote a file a CLI reads as instructions (CLAUDE.md, AGENTS.md, a settings file, anything in a hidden
     folder) in the folder or above it; a note beside it, or a folder that merely holds a written file further down,
     takes nothing away. A memory import writes notes only, in every folder: `.md` files, never one a CLI reads as
     instructions, rules or settings (CLAUDE.md, AGENTS.md, AGENTS.override.md, CLAUDE.local.md, GEMINI.md,
     opencode.json, mcp files, rules files ...), nothing hidden. Inside the Monos home (decided by the resolved path, by
     device and inode, and with case folded and trailing dots and spaces dropped, so a case alias or `monos.` is the
     same folder) it writes only the names a Mono's folder uses: `<id>/SOUL.md`, `MEMORY.md`, `soul-template.md`,
     `memory/<name>.md`, `skills/<name>.md`. A memory folder that reaches the Monos home under another name (another
     spelling, or a link) is refused, and a memory folder name ending in a dot or a space is never taken. A history
     restored for a memory folder loses its instruction files and hidden files again (the removal is amended into the
     restored tip, so the history keeps its length and the folder stays clean); other files stay.
     The folder is stored as this Mac resolves it. A worktree stays only when it is inside the chat's own project, or is
     a linked working copy `git worktree list` names for that project (never the main entry, and only when git says the
     project is the top of its own repository, so a parent repository can't vouch for a plain project inside it).
     Otherwise the folder is cleared and so is the chat's worktree: the chat opens with no folder, shows "Choose a
     project folder for this chat first." with a folder picker, and starts nothing until one is chosen. What the file
     named (mapped to this Mac's own folder where it can be, plus the project's id and the path below its folder) is
     kept as an inert note (`imported_chat_folders`, a real migration whose columns are kept whole on every open,
     removed with the chat and when relinked; nothing runs from it). A relink maps a chat's project folder through the
     project record as it is then, by id, so a project that only got its folder here after the import still finds its
     chats. The file's folder for a project must be a full path of at least three parts (never `/`, `/Users`, a home
     folder or this Mac's home folder), and only the deepest project a folder is in maps it; the banner offers it back
     (`portable_relink_candidate`) once it exists here and passes the same checks, and the "Needs a folder" group
     offers one "Relink all N" per project or Mono (`portable_relink_candidates`, `portable_relink_apply`). A note for a
     folder the import wrote instructions into is marked blocked and never offered, and a Mono's folder is looked at on
     disk again when it is offered (an instruction file there or above it, or a hidden tool folder, withholds it). A chat whose folder is in
     `~/agent-memory`, a hidden folder or outside the home folder can't be relinked, and the report says so. The report counts those chats
     (`foldersCleared`) and the automations that lost a folder the same way (`automationFoldersCleared`, they also come
     back paused). A chat with no folder is listed in the sidebar's "Needs a folder" group
     (`session_list_folderless`, with or without a message) until it gets one.
   - **Project folders.** The preview lists every project folder the file wants to register, each unticked (the file
     names them, so only a tick adopts one). Whatever is ticked, Rust refuses a folder that fails the allow-list above,
     a relative path, one that isn't a folder here, or one that isn't a git repository (the top of a repository is what
     says where a project begins; it is refused rather than warned about)
     (`refused_project_folder`, asked through `portable_project_folder_checks` in the preview and again as the import
     registers; with no checker, or if it can't be asked, nothing is adopted). The same allow-list keeps a refused
     folder from vouching for chats even if a project record has it, so a project outside the home folder shows as
     refused with the reason. Because the ticked projects are registered first, a restore on a fresh Mac keeps its
     chats' folders; an unticked project's chats come in with none.
   - **Monos' folders.** A Mono's project folders are this Mac's own project folders only (matched by project id), never
     a folder the file merely names. A Mono already seated here keeps its own project list unless its tick in the
     preview ("Add the projects the file lists") is set, and then it gains only those local folders. A Mono's team
     folder for a seated Mono is made before the chats come in, and one for a Mono that is only coming in after the Mono step.
   - **How it runs.** An imported chat or automation comes in at `supervised` whatever its file says (`full-access`
     maps to a provider's bypass-permissions mode), and the report says so. A delegation row stays only when both its
     chats came in with this import, and it is always history. A provider conversation id is kept only for a Claude
     chat that isn't private, that no other chat here holds, and whose transcript is in the Claude project folder of the
     chat's own kept folder.
   - **Paths in tool rows.** Every `paths` list and `preview.path` in a chat's blocks (tool rows, approvals, side
     threads, agent steps, at any depth) feeds the checkpoint calls, so only paths inside the chat's kept folder (or
     worktree) stay, `..` and links resolved; the rest are dropped (`toolPathsDropped`), and a `paths` that isn't a list
     is dropped. A chat with no kept folder keeps none.
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
