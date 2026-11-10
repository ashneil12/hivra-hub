# WP-137: Spaces, split view and windows

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none in this tree | yes |

This package started as design only. The first build is in; see "Status" at the end for what is built and what is left.

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

1. A space is not a new object. It is an explicit, per-window filter on a project group that already exists. Chats and folders stay as they are. Other projects leave the rail only when the person turns that filter on.
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

### Extra windows and the tray

Extra windows are already worth having on macOS, and they are already built. A tray is not.

App: New Window (`open_new_window` in `src-tauri/src/window.rs`) opens another workspace window. It is on the menu and the command palette. Each window is a view of the same projects and the same chats. The "Show only this group" filter, if a later build adds it, is per window, so one window can look at one group while the other shows the full rail.

The second window must stay a view. Steering, delegations, stall watch, and PR watch already run only in the main window, because a second copy of the same App would submit the same pending rows twice (`useSteering.ts`). A later build must not start those loops in the extra window, and must not give the extra window its own chat list or its own copy of a chat.

That is the recommendation. Keep New Window. Do not add a special "agents only" window. Cursor's Agents window is the product people compare when they want agents off to one side. Hivra's extra window is already the whole workspace, which covers that without a second kind of window. Cloud sessions are WP-136, not this note. Claude Desktop being kept open beside a coding app is the same job as this extra window, or as a split. This design does not add a design surface. The Codex app and Paseo are not a source for windows or a tray: the parity notes do not describe one.

A macOS tray should wait.

Windows already has a tray (`src-tauri/src/tray.rs`, Windows only). Closing a window there hides it, and a hidden window leaves the taskbar, so the tray is how you get it back. macOS does not have that hole. The Dock stays, and `show_hidden_or_open_new` brings hidden workspace windows back. The Mono menu bar is a chat for one Mono, not a list of every chat and not a stand-in for the Windows tray.

A tray that listed chats would be a third inbox, next to the chat list and Being built. It would be pushed to float whatever needs the person, which is the re-sort this design forbids. Discussion 6889 can stay a note. If a tray is built later, it only opens the app. It does not list chats, and a click does not reorder anything.

So: keep the extra window, on macOS and everywhere else it already exists. Do not add a macOS status item in the first build that follows this note.

### No silent re-sort

The chat list already has an order. This design does not change it. It only forbids chrome from becoming a new reason to shuffle that order.

Today, `compareSessionSummaries` puts pinned chats first, then the most recently updated, then breaks ties by id. The sidebar sorts with that comparator whenever it draws. The project rail does not. `projectRailSections` follows the saved rail order, pins first. Being built does neither: the last-active label changes in place, and the row stays put (`HANDOFF.md`, Unit 7).

WP-113 may later let a chat that needs the person move up, and only when its own setting is on. That setting stays off here. This design does not call it, and a space, a split, or a focused window is not "needs you".

These actions must leave every visible row where it was, relative to the rows that are still visible:

- Selecting a group, turning "Show only this group" on, turning it off, or switching groups.
- Splitting, closing a pane, focusing a pane, or dragging a sash.
- Opening New Window, focusing a window, clicking the Dock, or clicking the Windows tray.

Rows the group filter removes come back in the same rail position when the filter goes off. They are not appended, and they are not moved to the top. Chats do not move at all for these actions, including chats inside a folder. Folder member order uses the same comparator, so a bump to a chat's updated time would reshuffle the folder too. Do not bump it.

What may still move a row, because it already does, or because the person did it on purpose:

- A new message or other real update that already changes `updatedAt`.
- Pin, unpin, or a drag that reorders the rail or a folder. That writes the saved order. It is not a side effect of opening a space.
- Archive, and settle or snooze if WP-113's setting is on. Those are that package's actions, not these.

The trap to test for: `summaryFromSession` stamps `updatedAt` with the current time on every build. `sameSessionSummaries` only treats a restamp inside 30 seconds as the same row for an equality check. It does not freeze the sort. A focus, a split, or a new window must not rebuild a summary and merge it. If it does, the chat jumps to the top even though the person only looked at it.

Being built stays put even if a group filter is on. Do not float the jobs for that group to the top. Leave each row where it is, or do not show Being built in the filtered rail. Do not sort it.

Two windows share one order. Focusing the second must not reshuffle the first. The group filter is per window and must not be written back as a new rail order. A write to the shared group list that is not based on the list the window last read is dropped. It is not retried as a reorder. Closing a window drops that window's filter and writes nothing.

A stored filter that names a missing group is ignored. Ignoring it shows the full rail in the saved order. It does not sort. An empty group shows an empty section. It does not pull in other projects to fill the gap.

A later build can prove this with a fixed list. Three chats with update times 1, 2, and 3 stay in that order after the filter, a split, and a window focus. A pinned chat stays above a newer unpinned one, and two pins do not swap. Projects hidden by the filter return to their saved rail slots. None of those steps calls `summaryFromSession`.

### No implementation (design round)

The design round stopped at the design. The build round that followed is described under "Status".

## Done when

- [x] The design covers spaces, split, windows, and the re-sort rule.
- [x] It reuses the existing pane split, and explains why there is no WP-109 to reuse.
- [x] No product UI was added (design round).
- [x] Build round, first slice: groups on the project strip and "Show only this group", per window, off by default,
  with no re-sort (see "Status").

## Licence

The behaviour in this note is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. This note does not copy T3 source. It does not copy T3 Connect, Clerk, telemetry, or the T3 name.

## Addendum (10 Nov 2026): an agent can show a file or a diff beside its chat

Source: Sidecar (MIT, Copyright (c) 2025 Marcus Vorwaller). Ideas only, no code copied. Design input only, since WP-137 is design.

Add a chat card of type file (path and line) or diff (a commit or the working tree) that an agent can post, shaped like Sidecar's `sidecar open path:line`. The card opens in the pane tree this WP defines. It is one more card type, not a second layout: no pane, window or space is added for it. No new capability advert is needed, since `app actions.list` already lists the verbs. Done when the design names the card, its refusals (a path outside the project, a missing file) and the pane it opens in, and reuses the existing pane split.

## Status (10 Nov 2026): first slice built

### What the design missed about Hivra

The design reads the rail's project groups (`ProjectRail.tsx`, "New group") as something Ash already has. In Hivra he
does not see them: the Hub flag hands the rail `hubItems`, which replace its Pinned, Groups and Projects lists, and the
projects Ash picks from are the project strip (`src/features/hub/ui/ProjectStrip.tsx`), which had no groups. So this
build brings the existing group list to the strip instead of adding anything new: the same `monocode.projectGroups`
list and the same assignment map in `projectGroups.ts`. A strip project's assignment is keyed `hub-project:<id>`, a key
no folder path can take, so the strip and the classic rail never fight over a key. One project, one group.

### Built

- `src/features/hub/model/stripGroups.ts`: the strip's sections (`stripLayout`), this window's filter, and the writes.
  - With no groups the strip is exactly today's strip. Projects in no group come first, then each group under its
    heading, all in the saved project order. Nothing sorts.
  - "Show only this group" is a second, explicit action from a group heading's menu. Making a group, choosing one or
    opening a project never turns it on. It shows that group's heading and projects and a "Show all" button; the others
    come back in the same slots when it goes off. The open project and its chats stay as they were.
  - The filter is view state for one window, kept in that window's `sessionStorage`: a reload keeps it, a new window
    starts without it, closing the window drops it, and it is never written into the group list or the project order.
    A stored filter naming a group that is gone is ignored (the full strip). A group with no project on the strip (the
    list is shared with the classic rail's folder groups) gets no heading, except the group the filter is on, which
    keeps its heading and "Show all" as an empty section.
  - A project never vanishes under the filter: one moved out of the shown group (No group, another group, New group)
    turns this window's filter off, and one made with "+" while the filter is on joins the shown group (if that can't
    be saved, the filter goes off instead).
  - Move up / Move down in a project's menu trade places with the neighbour in its own section as the strip draws it
    (the projects in no group, or its group); each is left out where there is no neighbour that way.
  - Every write to the shared group list is checked against the list that window last read. If another window changed
    it since, the write is dropped (not merged, not retried) and the menu says "The groups changed in another window.
    Nothing was changed here; try again." A rename or delete of a group another window deleted closes its box and says
    "This group is gone: it was deleted in another window." The strip re-reads the list on another window's `storage`
    event and on focus.
  - A blank group name is refused. A second group with a name another group has gets a distinct one ("Work 2"), on
    create and on rename, and keeps its own id.
  - Deleting a group asks first ("Its projects stay on the strip."), removes the heading only, and turns this window's
    filter off if it was on that group.
- `src/features/hub/ui/StripGroups.tsx`: the heading, its menu (Show only this group or Show all projects, Rename group,
  Delete group) and the project menu's "Group" chooser (each group, No group, New group). No group colour on the strip
  or in the chooser: the strip keeps colour for status, and the shared palette has red, orange, yellow and green.
- Hooks only in upstream-shaped files: one menu item and one mode in `ProjectMenu.tsx` (and its Move up / down reading
  the strip's sections), the sections in `ProjectStrip.tsx`, one call in `NewProjectView.tsx`'s Create. No change to `App.tsx`, `src-tauri/src/lib.rs` or `SettingsView.tsx`; no setting, no migration, no
  Rust.
- Split view and windows: nothing new was built, as the design says. The browser spec proves the existing split tree and
  a second window with the filter: a split of the open chat, a chat dragged from the list into the split (it fills the
  split's blank pane, opened once, not copied), and a second window that shares the group list, starts with its own
  filter off, and whose rename reaches the first window.
- No re-sort, proved with three chats updated 3, 2 and 1 minutes ago: their order is the same after making a group,
  turning the filter on, a reload, opening the oldest chat, a split, a drag into the split, a second window, a rename
  there and a focus back.

### Decisions left to Ash, taken the conservative way

- Overlapping groups (a project in two groups): not built. One project, one group, as the design says until Ash decides.
- A macOS tray: not built, as the design says.
- The word "space" is not on screen. The label is "Show only this group".

### Next slice

- Reorder groups on the strip (drag a heading), and collapse a group there. The rail's group order is kept and used, but
  the strip has no way to change it yet.
- The addendum's file or diff chat card an agent can post (Sidecar's idea), opening in the pane tree. It needs its own
  design pass for the card shape and its refusals before a build.
- Hub projects removed from the strip leave their `hub-project:<id>` assignment behind (harmless: it shows nowhere).
  A tidy-up on remove is a small follow-up.

### Tests

- `src/features/hub/model/stripGroups.test.ts`: the layout (no heading for a group with no strip project), Move up /
  down within a section, the filter's storage and when it goes off, a new project joining the shown group, the guarded
  writes, a group gone in another window, and the naming rules.
- `src/features/hub/ui/ProjectStrip.groups.test.ts`: the strip with no groups, making a group from the project menu, the
  filter and its survival across a remount, Show all, delete with its question, a filter naming a missing group, Move up
  / down within a section, a move to No group under the filter, a folder group with no heading, and the gone note.
- `src/features/hub/ui/Projects.record.test.ts`: Create while the filter is on puts the new project in the shown group.
- `tests/browser/wp137-spaces.spec.ts` (`npx playwright test -c tests/browser/wp137.config.ts`, Chromium and WebKit): the
  whole flow in the real app in a browser, a reload, a split, a drag into the split, and a second window.
