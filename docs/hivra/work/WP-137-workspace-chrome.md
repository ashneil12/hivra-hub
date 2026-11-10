# WP-137: Spaces, split view and windows: design only

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none in this tree | yes |

This package is design only. It adds this note and the source line for the idea. It does not add product code, a setting, a migration, or UI.

## Goal

A design for named spaces, a split beside the open chat, and optional extra windows. All of it stays off until the person asks for it. Opening a space, splitting, or focusing a window must not silently re-sort the chat list.

## Why

T3 Code has not shipped these. The open requests are Spaces ([discussion 6733](https://github.com/pingdotgg/t3code/discussions/6733)), split view ([discussion 6746](https://github.com/pingdotgg/t3code/discussions/6746)), multiple windows ([discussion 6740](https://github.com/pingdotgg/t3code/discussions/6740)), and, as a side note, a system tray ([discussion 6889](https://github.com/pingdotgg/t3code/discussions/6889)). The 6 Nov survey recorded the Spaces complaint as a long flat list of projects and threads with no way to separate them by context, at 44 upvotes. The 9 Nov parity note still had all four discussions open. The two vote counters are not the same number, so this note does not pick one.

Hivra's list is not that flat. Projects already sit in groups on the rail, and chats inside a project already sit in folders. The design below uses those, instead of adding a third hierarchy that would hide chats the person did not put away.

## Read first

- Chat list order: `compareSessionSummaries` in `src/features/sessions/data/sessionHistory.ts`, applied in `src/app/shell/Sidebar.tsx`. Pinned rows, then most recently updated, then id.
- Chat folders: `src/features/sessions/model/sessionFolders.ts`. A folder is per project. A chat in a folder leaves the loose list and shows inside the folder.
- Project groups: `src/features/projects/model/projectGroups.ts` and `src/app/shell/ProjectRail.tsx`. A group is a heading. Projects with no group still show.
- Project rail order: `projectRailSections` in `src/features/projects/model/recents.ts`. Saved order, pins first, not recency.
- Split tree: `src/features/workspace/model/layout.ts`. Right, down, files, changes, and terminals are already panes on a chat tab.
- Extra windows: `open_new_window` in `src-tauri/src/window.rs`, already on the menu and the command palette as App: New Window. Only the main window delivers steering, delegations, stall watch, and PR watch (`src/features/firstmate/hooks/useSteering.ts`).
- Tray: `src-tauri/src/tray.rs` is Windows only, so a hidden window can be opened again. macOS uses the Dock and the Mono menu bar (`src-tauri/src/mono_chat.rs`), not that tray.
- Being built: rows never re-sort. The last-active label updates in place (`HANDOFF.md`, Unit 7).
- Settle and snooze: WP-113, a different package. Its re-sort is a setting, off by default, and it does not touch Being built. This design does not turn that setting on and does not depend on it.
- Side questions: WP-112. A side question borrows the open chat and stays off the chat list. It is not a second chat pane.
- Boards (WP-71) group tasks. Rooms (WP-22) are a conversation. Team workspaces (WP-80) are shared people, and that package has not started. None of these is a space.
- There is no WP-109 document in `docs/hivra/work`, and no WP-109 brief in the research notes. The 9 Nov parity line that said "pane split (WP-109 in batch)" does not match this tree. The pane split is the workspace layout above, already shipped with upstream tabs.

## Design

Four decisions. The sections under this one are the reasoning.

1. A space is an opt-in view over the project groups and chat folders that already exist. It is not a new parent of projects, boards, or chats. The full list stays on screen.
2. A split reuses the workspace split tree. Two chats, a chat and a diff, and a chat and a terminal can already sit together. Do not build a second splitter.
3. Extra windows already exist and are worth keeping. A macOS tray is later polish, not part of the first build.
4. Opening a space, splitting, or focusing a window must not reorder the chat list, the project rail, or Being built.

## Done when

- [ ] The design covers spaces, split, windows, and the re-sort rule.
- [ ] It reuses the existing pane split, and explains why there is no WP-109 to reuse.
- [ ] No product UI was added.

## Licence

The behaviour in this note is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. This note does not copy T3 source. It does not copy T3 Connect, Clerk, telemetry, or the T3 name.
