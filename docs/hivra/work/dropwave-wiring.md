# Dropwave frontend wiring list (first cut)

Branch: `claude/project-thread-m12ut3` (PR #252), head `70c6ab4c` (main `3aef51a2` merged in). Written 11 Nov 18:45 UTC; G15 added 19:00.

How to read it. "Works" means the screen reads and writes the app's real store or Rust command in the normal build, and
that path existed on main before this branch. "Thin" means it works but the state is kept somewhere too weak for a
shipped app (one window's storage, or memory for this run), or one part is not wired. "Missing" means the control is on
screen and nothing real is behind it yet. Nothing here was exercised in the native app: this is from reading the code,
the unit tests and the browser build. Every `invoke("…")` name the frontend calls (623 of them) has a Rust function of
the same name, so no screen calls a command that does not exist.

The mockup's example data (`src/dev/mockup/*`) only loads in the mockup build (`npm run mockup:build`). The real app
never reads it, so "example data" is not a state any real screen is in.

## What a builder should pick up (the gaps, most important first)

| # | Gap | Where | What is needed |
|---|-----|-------|----------------|
| G1 | A first mate's extra chats (`Mono.chats`), the per-project Chief of Staff chats (`Mono.projectSessions`) and team-chat sessions live in the roster in the window's `localStorage` (`monocode:monos…`, `ROSTER_KEY` in `src/features/monos/model/mono.ts`). | `mono.ts` `saveMonoSideChat`, `saveMonoProjectSession`, `saveMonoRoomSession` | Confirm the roster is mirrored to the Monos' home on disk like the rest of a Mono (teamPack / monoFiles) and that `chats` survives that round trip; add `chats` and `projectSessions` to Export and import (`src/features/portable/model/importPlan.ts`, `setupDoc.ts`). A test that a relaunch keeps a first mate's second chat. |
| G2 | Deleting a first mate leaves its extra chats behind as plain chats. Resetting an extra chat (`resetMonoSession`) re-files the fresh one as the main chat. | `monoWorkspace.ts` `resetMonoSession`; wherever a Mono is removed | On remove: drop or re-home `chats`. On reset of a side chat: replace the id inside `chats` (add `replaceMonoSideChat`). |
| G3 | The Chief of Staff's own chat for a project is "geared" to it only by working folder and a name label. No project brief is put in front of it. | `ensureMonoProjectSession` (`monoWorkspace.ts`), `monoProjectName` (`SessionPane.tsx`), the Mono prompt builders in `monoRun.ts` / `monoFiles.ts` | Give that chat the project's brief (name, one line, folder, its first mates, open needs) at the start of each turn, the way a Lead gets its project. Home's Chief chat keeps the every-project view. |
| G4 | Which chat is pinned on top in a project (Chief of Staff or the Lead) is kept in memory for this run only. | `src/features/hub/model/projectFront.ts` | Persist per project (project prefs in the local hub store), so a relaunch opens the same one. |
| G5 | Home's card order is kept in one window's storage. | `HomeScreen.tsx` `CARD_ORDER_KEY` | Move into Home's saved arrangement (`src/features/home/model/arrangement.ts`, already persisted) so every window and a restore agree. |
| G6 | "Show code tools" (Git, files, changes, worktrees in a project's sidebar) is one window's storage. | `src/features/settings/model/codeTools.ts` | Move to the app settings store (`settings.ts`). |
| G7 | Team chats (members, conversations, who answers, lead) are in `localStorage` (`CHAT_KEY` in `hubChats.ts`). This is how main already works, but with Teams now a first-class sidebar section it should be in the app's database. | `src/features/hub/model/hubChats.ts` | Move to `hub_local_docs` (`src-tauri/src/local_hub.rs`) with the revision rule the other local hub documents use, and keep the one-time import from `localStorage`. |
| G8 | Pages (kept pages, pins) are in `localStorage` (`pages.ts`). AGENTS.md says kept Pages belong to the local hub store (WP-33 takes them over). | `src/features/pages/model/pages.ts` | Finish WP-33's move; the pinned rows in the sidebar and the per-project filter read `allPages()` and need no change. |
| G9 | Council mode is a switch under a team chat's box, but a council run keeps its own thread and record, apart from the team conversation it was started in. | `GroupChatView.tsx` (`CouncilSwitch`, `CouncilRoom`), `src/features/council/model/record.ts` | Decide: file the council's verdict back into the team conversation as one message with a link to the full run. |
| G10 | The Inbox now leads with the one Needs you list (`InboxNeeds`), and the first-mate panel under it (`FirstMateInboxPanel`) lists this project's decisions again with its own answer buttons. | `src/features/needs/ui/InboxNeeds.tsx`, `src/features/crew/ui/FirstMateInboxPanel.tsx` | Fold the two: one list, with the first-mate panel's versioned answer (`tauriFirstMate.answer`) behind the row's button. Until then a decision can show in both. |
| G11 | A new extra chat with a first mate is titled by the default auto-title, and its row shows the first mate's name where a model name normally sits. | `Sidebar.tsx` `sideChatMark` | Nothing blocking. Optional: title from the first message at once. |
| G12 | Onboarding's first-run choices and "setup proved" are in `localStorage` (`onboarding.ts`, `setupProof.ts`). Clearing the webview's storage shows the welcome again. | `src/features/hub/model/onboarding.ts`, `setupProof.ts` | Mirror "onboarded" into the database (a settings row) and treat an existing roster or project as "not first launch". |
| G13 | Browser specs still drive the old screens (Coding team row, Today, the floating Copy chat link, the old Compare panel markup). | `tests/browser/*.spec.ts` | Update with the screens: see "Browser specs to update" below. |
| G15 | **Missing, found after the first cut.** "New page" on the Pages screen (and "Change" on a kept page) takes the description and answers "Not connected yet": the build call behind it went with Ash OS (WP-04), and `buildOnce` returns `not-connected` unless the dev stub is on. A first mate can still build a page when asked in its own chat (`page_build`, `src/features/selfBuild/model/pagesChat.ts`). | `src/features/pages/model/buildPage.ts` `buildOnce`; `PagesView.tsx` lines around `buildPage(` and `rebuildPage(` | Send the description to the chosen first mate's own session as a page build ask and collect its `page_build` preview (the chat path already checks the spec with `checkBuiltSpec(…, {real: true})` and shows the preview on Pages), so the card on Pages and the chat are one path. Same for Change with the page's current spec. |
| G14 | Orbit-style docs (block documents, WP-72) exist (`src/features/docs/*`) but have no entry in the Dropwave sidebar. | `ProjectRail.tsx` `placesNav` | Product call, not a bug: Ash wants these to come back later as pages ("hubs") or mods. No work until he asks. |

## Screen by screen

### Project strip (far left)
| Control | Calls or reads | State |
|---|---|---|
| Home tile | `showAppItem("home")`; selected by `homeInView` (`hub/model/homeScope.ts`) | Works |
| Project tiles, red counts | `hubData().listProjects()` (local hub store, `hub_local_docs`); counts from `useNeedsYou()` | Works |
| + New project | `setHubSelection({item:"new-project"})`, then `createProject` (`projectActions.ts`) | Works |
| Right-click a project | `ProjectMenu` (rename, icon, folder, remove) | Works |

### Sidebar, top (every place)
| Control | Calls or reads | State |
|---|---|---|
| Search | the app's search view | Works |
| Home | `showAppItem("home")` or `showProjectHome` | Works |
| Chief of Staff | On Home: `openChiefChat` → `ensureMonoSession`. In a project: `openProjectChief` → `ensureMonoProjectSession` | Works; G1, G3 |
| Inbox, red count | `onOpenInbox`; count is `useNeedsYou().length` | Works |
| Notes | `NotesView` (`notes_list`, `notes_get`, `notes_delete`, …) | Works |
| Automations | automations view (`automations_*`, `automation_runs_*`) | Works (off in a dev copy by design) |
| Pages | `PagesView`; opens on the project in view (`pagesScope`) | Works; G8 |
| Pinned page rows | `pinnedPages()`; all of them on Home, the project's own in a project | Works; G8 |

### Home
| Control | Calls or reads | State |
|---|---|---|
| The Chief of Staff box (ask, quick prompts, last exchange, answer a question it asked) | `sendHomeTurn`, `ensureHomeChief`, `answerHomeQuestion` (`home/model/homeChief.ts`); the host is set in `App.tsx` and uses the Chief's real session | Works |
| Needs you card (rows, one-tap buttons, "see all") | `useNeedsYou()` (`needs/model/needsLive.ts`: decisions, questions, stopped chats, checks, reviews, PR watch); buttons run the row's own action; a row opens `needTarget(item)` | Works |
| Working now card | delegation rows (`useNeedsYouRows`, `workingLines`) | Works |
| Done today card | `doneToday` from merged PRs (PR watch), work log lines, accepted delegations | Works |
| Project cards | `hubData().listProjects()`, per-project needs and working counts | Works |
| Customize (show, hide, order sections; pinned plugin panels) | `home/model/arrangement.ts` (saved) | Works |
| Drag cards to reorder | `CARD_ORDER_KEY` in this window's storage | Thin: G5 |
| Autopilot switch (Home: everything; a project's home: that project) | `home/model/projectAutopilot.ts` → `autopilot_status`, `autopilot_set`, `autopilot_off` | Works in the app. In a browser preview it is a window-only switch. |

### A project's home
| Control | Calls or reads | State |
|---|---|---|
| Same cards as Home, scoped to the project | same sources, filtered by `projectId` | Works |
| First mates list (name, role line, "3 working · 1 needs you") | roster (`listMonos`), `useNeedsYou`, delegation rows | Works |
| + beside First mates | new first mate (drafted in chat, made on yes) | Works |
| Teams list, + New group chat, delete a team chat | `hubChats.ts` (`listChats`, `createChat`, `deleteChat`) | Works; G7 |

### One-to-one chat (Chief of Staff, a Lead, any first mate)
| Control | Calls or reads | State |
|---|---|---|
| Chat list on the left with one chat pinned on top | `codingTeamList` in `App.tsx`; who is pinned from `projectFront` | Works; G4 |
| New chat (while a first mate's chat is open) | `startMonoSideChat` → a new session stamped as that first mate's, saved in `Mono.chats` | Works; G1, G2, G11 |
| An extra chat's row (mascot, the first mate's name) and opening it | `isMonoSideChat`, `openMonoSideChat` in `App.tsx` | Works |
| Chat row menu: rename, pin, delete, Copy chat link | existing session actions; `chatLink` (`sessions/model/threadLinks.ts`, `hivra://local/chat/<id>`) | Works |
| Sub-chats line ("3 sub-chats · 1 needs you") | delegation rows | Works |
| Composer: model picker | existing; the flyout fix is in `shared/lib/popover.ts` | Works |
| Composer: permission mode | existing | Works |
| Composer: Compare | `FanOutPicker` → `planFanOut` (WP-135). Hidden on a compact composer and before the first message, as on main | Works |
| Copy prompt link, Side question | existing | Works |
| Right panel (Sessions, notes, history, changes) | existing | Works |

### Team chat (group chat)
| Control | Calls or reads | State |
|---|---|---|
| Members, add or remove a first mate | `addMember`, `removeMember` (`hubChats.ts`) | Works; G7 |
| Conversations (new, rename, delete) | `startConversation`, `renameConversation`, `deleteConversation` | Works; G7 |
| Sending a message, who answers | `sendMessage` → the group runner set in `App.tsx` (each member's own session through `ensureMonoRoomSession`) | Works |
| Goal button | `startGoal`, `roomGoal` | Works |
| Council mode switch | `CouncilSwitch` → `CouncilRoom`, `requestCouncil` | Works; G9 |
| Who answers, Lead | Moved to Settings, Teams (`RoomResponder.tsx`: `setRoomResponder`, `setRoomLead`) | Works |

### Inbox
| Control | Calls or reads | State |
|---|---|---|
| Needs you section at the top | `InboxNeeds` → `useNeedsYou()`; button runs the row's action; a row opens `needTarget` | Works; G10 |
| First-mate decisions, results, failures; digest line | `FirstMateInboxPanel` (`tauriFirstMate.decisions`, `.answer`, `delivery_list`) | Works |
| Plugin installs waiting for a yes | `PluginApprovals` | Works |
| GitHub, GitLab, Linear, Jira, Azure DevOps items; filters; Add connection | upstream Inbox (`gh` on the Mac, tracker tokens) | Works when a connection exists; empty with a "connect" line otherwise |
| Item detail (merge, checks, diff, comment, Ask) | upstream Inbox | Works |

### Pages
| Control | Calls or reads | State |
|---|---|---|
| Project tabs (All, each project, Not tied to a project) | `pagesScope`, `allPages()` | Works |
| New page (describe it, a first mate builds it, preview before keeping) | `buildPage` → `buildOnce`, which has nothing behind it since Ash OS went | **Missing: G15.** Asking a first mate in its chat works. |
| Change on a kept page | `rebuildPage` → the same `buildOnce` | **Missing: G15** |
| Open a page, New page from inside one, the page's own 3-dot menu (pin, rename, delete) | `pages.ts` | Works; G8 |

### Settings
| Section | Calls or reads | State |
|---|---|---|
| General, Appearance, Keybindings, Usage | existing | Works |
| First mates | roster, per-mate engine, role, connectors | Works |
| Teams: every project's team chats, who answers and lead per team, teams you set up, proposals waiting | `TeamsPage.tsx`, `RoomResponder.tsx`, `hubTeams.ts` | Works; G7 |
| Chat | existing chat settings | Works |
| Providers, Skills, Connectors, Connected apps, Memory | existing | Works |
| Decisions, Activity, Work log, Changes, Chat history | existing | Works |
| Export and import, Backups, Secrets | existing | Works; G1 (extra chats not in the export) |
| Advanced, Worktrees: Show code tools | `codeTools.ts` | Thin: G6 |

### First run
| Control | Calls or reads | State |
|---|---|---|
| The four setup checks | `checkHubSetup` (`setupProof.ts`): Claude Code installed, signed in, a folder, one real round trip | Works |
| Welcome, start (project, CLIs, starter first mates), look, done | `HubOnboarding.tsx` → `createProject`, `addStarterMono`, `applyThemePreset`, `finishOnboarding` | Works; being reworded and shortened on this branch now; G12 |

## Browser specs to update (G13)
- `tests/browser/wp22-groups.spec.ts`: done on this branch (the harness mounts the team settings beside the room).
- `tests/browser/wp135-fan-out.spec.ts`: the Compare panel is now a shared Popover with `role="checkbox"` buttons, a "Review" step, then "Start chats". The `data-fan-out-*` hooks are kept.
- Any spec that clicks `[data-hub-item="coding-team"]`, `[data-hub-tasks]` or the floating "Copy chat link" button: the Coding team row and Tasks row are gone from the sidebar and the link is in the chat row menu.
- Any spec that expects the sidebar label "Needs you" in the full rail: it is "Inbox" with the red count (the compact rail keeps "Needs you").
- New screens with no spec yet: Home as its own place with its Chief of Staff, the project Chief of Staff chat, extra chats per first mate, Pages opening on the project, Settings, Teams rows opening to their settings, Needs you at the top of the Inbox.
