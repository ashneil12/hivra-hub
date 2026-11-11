# WP-214: Words, Settings and leftovers

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-210, WP-211, WP-212, WP-213 | yes |

## Goal

Each thing has one name, the app calls itself Hivra in its own words, and Settings holds only settings, in twelve
sections. Leftovers that don't work, or that belong to someone else, are gone. [UX.md](../UX.md) "One name for each
thing" and "What goes away" are the lists this package makes true.

## Why

In 0.16.15 the same thing had three names ("Waiting on you", "Asking you", "Waiting for you"), the app said
"MonoCode" and "MonoCode Hub" in its own text, and Settings had 28 sections. Some of those sections were things you
look at, not settings. Placeholder badges, an update row with no update server and upstream's star prompt were still
on screen.

## Read first

- [UX.md](../UX.md), all four mockups.
- `settings/model/settings.ts` (`SETTINGS_SECTIONS`, `SETTINGS_GROUPS`), `settings/ui/SettingsView.tsx`, and
  `hub/model/hivraLayout.ts` (`HIVRA_LAYOUT_HIDDEN_SETTINGS`, the pattern for hiding upstream's sections in the Hub
  only).
- AGENTS.md "Upstream rules": upstream's own strings and sections stay in the non-Hub build. Every change here is
  behind `IS_HUB_BUNDLE` or in Hub-owned files.

## Build

1. **Names.** Apply UX.md's table to every string a person sees in the Hub bundle: Needs you, Coding team, Pages,
   Working now, Hivra, and names in place of ids or paths. Code identifiers, storage keys and test ids don't change.
   Add a test that fails when one of the old words shows in the Hub's rendered text: "Waiting on you", "Asking you",
   "Waiting for you", "Being built", "Moving now", "Hivra lead", "Dashboards", and "MonoCode" outside the build
   footer.
2. **The app's name in its own text** is Hivra in the Hub bundle. Use one helper that the Hub's copy reads. The bundle
   name, identifier, data folder and Dock name do **not** change here: that is the rename (WP-07 step 2), which comes
   last and on its own. A dev copy's window title stays `Hivra Dev - <branch> @ <sha>`.
3. **Settings, in twelve sections** (Hub bundle; upstream keeps its 28). The groups are:

   | Section | Holds today's |
   | --- | --- |
   | General | General, Keybindings |
   | Appearance | Appearance |
   | Chats | Chat, Chat history, Archive, Trash |
   | Models | Providers (with More agents) |
   | Monos and crew | Monos, Crew, Teams |
   | Tools | MCP, Skills, Plugins |
   | Connectors | Connectors, Connected apps, Inbox's tracker accounts |
   | Machines and phone | Remote machines |
   | Worktrees | Worktrees |
   | Memory | Memory |
   | Autopilot | the per-project switches (the same ones as the project header) and Autopilot's log |
   | Data | Export and import, Backups, Changes (with Undo) |

   **Things you look at leave Settings** and go where you'd look for them:
   - Activity and Work log become Home's Done today › See all;
   - Usage opens from the status bar's usage line;
   - Decisions becomes "Past decisions" on the Needs you screen;
   - Dashboards are Pages.
   Search in Settings still finds every old label (keep them as keywords), and a saved section id that moved opens its
   new home.
4. **Usage once.** The status bar keeps the one usage line, for example "Claude: 72% of this week · 39% of 5 hours ·
   Grok: in use". Remove the other usage lines and chips from Home, the sidebar and the composer. "not connected"
   becomes words that say what is missing ("Usage unavailable: sign in to Claude in Models").
5. **Leftovers, in the Hub bundle:**
   - Ash OS's leftovers on screen. Settings › Export and import › "Bring over from Ash OS" stays.
   - The update row (the updater has no endpoints in this fork).
   - Upstream's GitHub star prompt.
   - Emoji reaction controls styled like buttons.
   - Any screen still showing `hubWork`, `hubBuilds` or `proposals` placeholder rows. They show outside a dev preview
     only if they hold real data.
6. **Automations** start from Ash's own projects and Monos ("Every morning, have the Chief of Staff …"). Upstream's
   template gallery moves under a "More ideas" link.

## Done when

- [ ] Tests:
  - the old-words test above;
  - Settings in the Hub bundle lists the twelve sections, and search finds each old label;
  - a stored old section id opens its new home;
  - the non-Hub build's Settings is unchanged (snapshot of section ids);
  - the status bar is the only usage line;
  - none of the leftovers render in the Hub bundle.
- [ ] Browser spec `tests/browser/wp214-words.spec.ts`: Settings (the list, search, a moved section) and Home, the
  project screen and Needs you checked for old words, with 1440 × 900 screenshots.
- [ ] Before and after screenshots of Settings, Home and a project in the PR (example data), and the same from a
  seeded dev copy kept on the Mac (`~/Worktrees/ux-shots/WP-214/`, never pushed).
- [ ] `npm run check` passes.
