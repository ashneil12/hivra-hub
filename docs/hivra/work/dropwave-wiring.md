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
| G15 | **Missing, found after the first cut.** "New hub" on the Hubs screen (and "Change" on a kept hub) takes the description and answers "Not connected yet": the build call behind it went with Ash OS (WP-04), and `buildOnce` returns `not-connected` unless the dev stub is on. A first mate can still build a page when asked in its own chat (`page_build`, `src/features/selfBuild/model/pagesChat.ts`). | `src/features/pages/model/buildPage.ts` `buildOnce`; `PagesView.tsx` lines around `buildPage(` and `rebuildPage(` | Send the description to the chosen first mate's own session as a page build ask and collect its `page_build` preview (the chat path already checks the spec with `checkBuiltSpec(…, {real: true})` and shows the preview on Pages), so the card on Pages and the chat are one path. Same for Change with the page's current spec. |
| G14 | Orbit-style docs (block documents, WP-72) exist (`src/features/docs/*`) but have no entry in the Dropwave sidebar. | `ProjectRail.tsx` `placesNav` | Product call, not a bug: Ash wants these to come back later as pages ("hubs") or mods. No work until he asks. |
| G16 | WP-242: "Learn skills" (Automatic, Ask first, Off) in Settings > Memory is one window's storage (`monocode.skillLearning`, `src/features/selfBuild/model/skillMode.ts`), beside the memory tier (`monocode.memoryTier`, `tier.ts`) which is kept the same way. Clearing the webview's storage puts it back to Automatic. | `skillMode.ts`, `tier.ts` | Move both into the app settings store (`settings.ts`) together. |

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
| Chief of Staff (pinned first, on Home and in a project) | One chat (`asks/model/oneChat.ts`): every way in is `openChiefChat` → `ensureMonoSession`, its one chat. `openProjectChief`, Home's box and a project home's box are turned to it in `App.tsx` (`onOpenMono`, `setMonoChatOpener`, `setHomeChiefHost`); a project home's message is prefixed "About <project>:" (`aboutProject`). Chats it had before are kept: its side chats under "Earlier chats" beside the one chat, a project chat under Everyone in that project's list | Works; G1 |
| Inbox, red count | `onOpenInbox`; count is `useNeedsYou().length` | Works |
| Notes | `NotesView` (`notes_list`, `notes_get`, `notes_delete`, …) | Works |
| Automations | automations view (`automations_*`, `automation_runs_*`); WP-244's "Only run when this changes" is kept in the local store document `schedule-watches` (`plugin:hub|local_hub_read`/`_write`) and read through `page_http_fetch`, `git_github_work_items` or `read_text_file` | Works (off in a dev copy by design) |
| Hubs | `PagesView`; opens on the project in view (`pagesScope`) | Works; G8 |
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
| + beside First mates ("New first mate") | a name and what it looks after: `onCreateMono(projects, profile)` in `App.tsx` (`createMono`, `saveMonoName`, `saveMonoRole`), joined to the project in view; or one already made: `joinableMonos` + `addMonoProject` (`MonoRailSection.tsx`) | Works |
| Teams list, + New group chat, delete a team chat | `hubChats.ts` (`listChats`, `createChat`, `deleteChat`) | Works; G7 |

### One-to-one chat (Chief of Staff, a Lead, any first mate)
| Control | Calls or reads | State |
|---|---|---|
| Chat list on the left, the open first mate's main chat on top | `codingTeamList` in `App.tsx`; who is in front from `projectFront` | Works; G4 |
| Whose chats: the first mate's own, or Everyone | `chatListScope.ts` (`inChatListScope`: a chat belongs to the first mate it is stamped with, or the one that started it, through `monoForSession` and the delegation rows); kept in `localStorage` | Works |
| New chat (while a first mate's chat is open) | `startMonoSideChat` → a new session stamped as that first mate's, saved in `Mono.chats` | Works; G1, G2, G11 |
| An extra chat's row (mascot, the first mate's name) and opening it | `isMonoSideChat`, `openMonoSideChat` in `App.tsx` | Works |
| Chat row menu: rename, pin, delete, Copy chat link | existing session actions; `chatLink` (`sessions/model/threadLinks.ts`, `hivra://local/chat/<id>`) | Works |
| Sub-chats line ("3 sub-chats · 1 needs you") | delegation rows | Works |
| Composer: model picker | existing; the flyout fix is in `shared/lib/popover.ts` | Works |
| Composer: permission mode | existing | Works |
| Composer: Compare | `FanOutPicker` → `planFanOut` (WP-135). Hidden on a compact composer and before the first message, as on main | Works |
| Copy prompt link, Side question | existing. Side questions are kept on the message they were asked under (`Block.btwThreads`, saved with the chat); the button says how many are kept and they come back as tabs | Works |
| Catch me up (the Chief of Staff's one chat only, beside Side question) | `requestCatchUp` (`asks/model/oneChat.ts`) → the host in `App.tsx` builds one app card (`asks/model/catchUp.ts`: `delegationRows()`, `decisions_list`, `currentNeedsYou()`) and appends it to the chat as a block (`Block.catchUp`, saved with the chat, drawn by `asks/ui/CatchUpCard.tsx`). No model turn. Each card starts where the last one in the chat ended. What Ash was shown rides beside his next message (`catchUpNote`) | Works |
| Right panel (Sessions, notes, history, changes) | existing | Works |

### Team chat (group chat)
| Control | Calls or reads | State |
|---|---|---|
| Members, add or remove a first mate | `addMember`, `removeMember` (`hubChats.ts`) | Works; G7 |
| Conversations (new, rename, delete) | `startConversation`, `renameConversation`, `deleteConversation` | Works; G7 |
| Sending a message, who answers | `sendMessage` → the group runner set in `App.tsx` (each member's own session through `ensureMonoRoomSession`) | Works |
| Several seats answering one message (held, then landing together; "No answer from ...") | `roomConductor.ts` gathers (`openGather`, `releaseGather`); `GroupChatView.tsx` `data-hub-msg-held`, `data-hub-msg-gather` (WP-245) | Works |
| Goal button | `startGoal`, `roomGoal` | Works |
| Council mode switch | `CouncilSwitch` → `CouncilRoom`, `requestCouncil` | Works; G9 |
| Who answers, Lead | Moved to Settings, Teams (`RoomResponder.tsx`: `setRoomResponder`, `setRoomLead`) | Works |

### Inbox
| Control | Calls or reads | State |
|---|---|---|
| All, Asks and each source's tab | `inboxShow.ts` (`useInboxShow`, `inboxParts`); kept in `localStorage`; a line from Home that leads to an ask switches a source's tab back to All (`opener.ts`) | Works |
| Needs you section at the top | `InboxNeeds` → `useNeedsYou()`; button runs the row's action; a row's words open its card beside the list | Works; G10 |
| A row's card: the ask, who and when, its answers, Open chat, a reply box | `NeedDetail.tsx`; answers are the row's own `actions`; Open is `openNeed` (`needContext.ts`), or for a decision the chat `needChatId` names (the chat that asked it, `askedBy`, when it is one of that first mate's own); the reply is `sendToChat(needChatId(…))` (`waitingChats.ts`) | Works. Open chat lands on the message that asked: `requestTranscriptAsk` finds it by the ask's words, else by the turn that was running when it was asked, and hands it to the jump search uses (`transcriptJump.ts`). When neither can tell, the chat opens on its latest message. |
| First-mate decisions, results, failures; digest line | `FirstMateInboxPanel` (`tauriFirstMate.decisions`, `.answer`, `delivery_list`) | Works |
| Plugin installs waiting for a yes | `PluginApprovals` | Works |
| GitHub, GitLab, Linear, Jira, Azure DevOps items; filters; Add connection | upstream Inbox (`gh` on the Mac, tracker tokens) | Works when a connection exists; empty with a "connect" line otherwise |
| Item detail (merge, checks, diff, comment, Ask) | upstream Inbox | Works |

### Hubs (`PagesView`)
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
| Crew: How tasks are tested (Test at ship, Light tests each task, Full checks each task, No testing), per project; from Home a project picker comes first | `TestingModeSetting.tsx` → `delivery_settings_get` (reads `testingMode`, `testingDefaulted`, `updatedAt`), `delivery_testing_mode_set` (writes on top of the `updatedAt` it read) | Works (SC-3a) |
| Crew: Proof tools (the open-source tools that fit the project, what each proves, a per-project switch for one the project has, More: licence, repo, install line), under How tasks are tested; from Home a project picker comes first | `ProofToolsSetting.tsx` → `proof_tools_list` (reads each tool's `installed`, `status`, `off`, and the project's switch `revision`), `proof_tools_set` (writes on top of the `revision` it read; a stale one is refused in plain words) | Works (PT-2) |
| Crew: When the checker runs (Follow the testing mode, Every code change, Only risky changes, Off; one line each, the cost behind More), app-wide, beside Who checks the work | `CheckerWhenSetting.tsx` → `checker_when_rule_get`, `checker_when_rule_set` (one word written whole; a word this build doesn't know is refused, and a missing one reads as Follow the testing mode) | Works (PT-4) |

### First run
| Control | Calls or reads | State |
|---|---|---|
| The four setup checks | `checkHubSetup` (`setupProof.ts`): Claude Code installed, signed in, a folder, one real round trip | Works |
| One thing a step: welcome (your name), the first project (or a restore), its first mates, the coding tools, a look, done (says back what was chosen) | `HubOnboarding.tsx` → `createProject`, `addStarterMono(id, [project])` (a picked first mate joins the first project; the Chief of Staff belongs to none), `saveChosenClis`, `applyThemePreset`, `finishOnboarding` | Works; G12. A restore skips the first mates and tools steps. |

## Browser specs to update (G13)
- `tests/browser/wp22-groups.spec.ts`: done on this branch (the harness mounts the team settings beside the room).
- `tests/browser/wp135-fan-out.spec.ts`: the Compare panel is now a shared Popover with `role="checkbox"` buttons, a "Review" step, then "Start chats". The `data-fan-out-*` hooks are kept.
- Any spec that clicks `[data-hub-item="coding-team"]`, `[data-hub-tasks]` or the floating "Copy chat link" button: the Coding team row and Tasks row are gone from the sidebar and the link is in the chat row menu.
- Any spec that expects the sidebar label "Needs you" in the full rail: it is "Inbox" with the red count (the compact rail keeps "Needs you").
- New screens with no spec yet: Home as its own place with its Chief of Staff, the project Chief of Staff chat, extra chats per first mate, Hubs opening on the project, Settings, Teams rows opening to their settings, Needs you at the top of the Inbox.
