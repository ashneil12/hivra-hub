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

### Spaces

A space is not a new thing that owns projects, chats, or boards. Hivra already has the two groupings this request is reaching for, and they are not the same as each other.

A project group is a heading on the project rail (`projectGroups.ts`, the rail's "New group"). A project is in one group or in none. Projects with no group still show under the rest of the rail. Collapsing a group hides that heading's projects until the person expands it. It does not archive them.

A chat folder is inside one project (`sessionFolders.ts`, the chat list's "New folder"). Dragging a chat into a folder takes it off the loose list and shows it under that folder. That is the person putting the chat away. An empty folder is not shown. Members inside a folder still use the chat list's usual order.

Boards (WP-71) group tasks, not chats. A room (WP-22) is one conversation with several agents. A team workspace (WP-80) is other people, and it has not been built. A Mono can already be given several projects. None of those should be renamed into a space, and a space should not sit above them as a third container.

The T3 request is a way to separate a long flat list by context. Hivra's list is already headed by groups and folders. The missing piece is only this: looking at one group on its own, without losing the others. That is a view, not a hierarchy.

The model:

- Off until the person uses it. With nothing selected, the rail and the chat list are exactly today's lists.
- The person picks a project group they already have. The view is called a space in this note so it can be compared with the T3 request. The label on screen stays "Show only this group". Do not add the word space to the UI unless a later package says to.
- "Show only this group" is a second, explicit action. Opening or selecting a group does not turn it on. It is per window. Turning it off shows every project again.
- While it is on, the rail shows that group's projects and no others. Those other projects are not archived, not deleted, and not moved into the group. They come back in the same rail order when the filter goes off.
- Chats are untouched. Opening a space does not move a chat into a folder, out of a folder, or off the list. A chat the person did not drag into a folder stays where it was. A new chat started while the filter is on is filed the way a new chat is filed today. It is not auto-added to a folder and not auto-assigned to the group.
- A space stores no chat ids and no task ids. Boards, docs, and the chat list stay on the project.

Do not make groups overlap as part of this design. A project in two spaces at once would be a second grouping beside groups. If that is needed later, change a group's assignment from one id to a list of ids. Do not add a space table next to the group table. That choice is left for Ash. Until then, one project, one group.

Creating, renaming, or deleting a group stays the rail's existing behaviour. Deleting a group removes the heading only. Turning the filter off is not deleting. A group id read back from disk that no longer exists is dropped. The other groups stay in their saved order. A blank name is refused. Two groups keep distinct ids even if a later edit would make the names look the same. Follow the folder rule and give the second one a distinct name rather than merging them.

Two windows share the group list. A window may have the filter on while the other does not. A write to the group list must be based on the list that window last read, so one window cannot wipe a group the other window just added. The same rule already applies to local hub documents when two windows are open. The filter itself is view state for that window, not a field on the group.

What this refuses:

- A space object that contains projects, which contain boards and chats.
- Hiding a chat because its project is outside the group on screen. Switch to that project from the full rail, or turn the filter off. Do not invent a second chat list inside the space.
- Putting every new chat into the open space.
- Using the filter to collapse folders or to settle chats. Settle stays in WP-113, off by default.

### Split view

There is no WP-109 to reuse. The parity note guessed a pane-split package still in flight. This tree has no such document, and the split is already the workspace layout in `src/features/workspace/model/layout.ts`. A tab holds a tree of panes. Same-direction splits share a group. The person drags a sash, drops a pane on an edge, or uses the existing split shortcuts (right, or down). A later build must extend this tree. It must not add a second split implementation beside it.

What may sit beside a chat, all of it already possible:

- Another chat. A second session leaf, to the right or below. Dragging a chat from the list onto an edge opens it there or moves it. It does not clone the chat. One chat is one turn, so two panes cannot submit the same turn twice.
- A diff. The right-hand panel already has Changes beside the chat (`RightPanelTab` includes `changes`, next to files, the graph, and crew). The same split tree can also hold a changes pane: the working tree, one chat's before-and-after snapshots, or one commit (`changes`, `sessionChanges`, and `commit` on a file pane). Use those. Do not add a new diff viewer. How the diff itself lays out lines (one column, or side by side) is WP-116, a different package. This design does not change that, and it does not make side-by-side lines the default.
- A terminal. A terminal pane is already part of the same tree. The first terminal in a tab opens below the chat. Further terminals join that pane. Orca is praised for terminal splits beside an agent. Hivra already has the pane, so this design does not add another terminal stack, and it does not take Orca's code. Paseo is not a source here: the parity notes do not describe a split to answer.

What must not be forced into the split:

- A side question (WP-112). That stays a borrowed-context question off the chat list. It is not the way to put two chats side by side, and it must not grow a row on the list because a pane opened.
- Being built, a board, Home, or Settings. Those are other screens. A board beside a chat can be a later package. It is not this one.
- A second copy of the same chat.

The right-hand panel and the split tree are two existing places a diff can sit. A later build should not invent a third. If the person wants the diff in the pane, open the changes pane. If they want it tucked beside the chat without splitting the chat, use the Changes tab. Both read the same git state.

Splitting does not change which project group is filtered, which folder a chat is in, or the order of either list. That rule is in the re-sort section.

## Done when

- [ ] The design covers spaces, split, windows, and the re-sort rule.
- [ ] It reuses the existing pane split, and explains why there is no WP-109 to reuse.
- [ ] No product UI was added.

## Licence

The behaviour in this note is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. This note does not copy T3 source. It does not copy T3 Connect, Clerk, telemetry, or the T3 name.
