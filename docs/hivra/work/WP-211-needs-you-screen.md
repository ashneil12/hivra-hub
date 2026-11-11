# WP-211: The Needs you screen replaces the Inbox

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | M | WP-210, WP-213; start after PRs #213, #220 and #225 merge (they change `FirstMateInboxPanel`) | yes |

## Goal

One screen lists everything that needs Ash, grouped by project, and lets him answer each item where it stands. It is
the "See all" from Home and the Needs you entry in the Home sidebar. It replaces the Inbox in the Hub. It matches
[ux/mockups/NeedsYou.png](../ux/mockups/NeedsYou.png).

## Why

In 0.16.15 the Inbox showed GitHub activity from upstream's repo, someone else's project. Its dot counted tracker
items only. The first mate's questions lived in a separate panel (`FirstMateInboxPanel`), and Settings had a
Decisions page for the same thing. Ash had three places to look and none of them agreed.

## Read first

- [UX.md](../UX.md), [ux/mockups/NeedsYou.png](../ux/mockups/NeedsYou.png), WP-210's `needsYou.ts`.
- `inbox/ui/InboxView.tsx` and `inbox/model/*` (upstream's tracker inbox: keep the code, route around it in the Hub),
  `crew/ui/FirstMateInboxPanel.tsx`, the Settings › Decisions section, `delivery-gate/ui/GateCards.tsx`.

## Build

1. **The screen.** At the top: "Needs you" and "N things, from every project". Under it, one grey line: "Every number
   you see on the rail, in the sidebar, on Home and in a project counts this same list. Answer here or in the chat it
   came from: it clears everywhere at once."
2. **Filter chips** by kind, each with its count: All, Stopped, Questions, Approvals, Ready to merge, Reviews, and
   Checks only when there are any. A chip with zero is hidden. When opened from a project's header chip, the screen
   starts filtered to that project, and a removable chip names it.
3. **Groups by project**, in rail order. Each group has the project's tile, its name and its count. Each row has:
   - a coloured kind chip;
   - the item's sentence;
   - a grey line, "<who> · <age>";
   - the item's actions as buttons, the primary one blue.
   Answering in place uses the item's own handler. A question with free text gets a "Reply" button that opens a short
   inline box. The row leaves the list when its source says it is answered.
4. **Fold in.**
   - The first mate's questions (`FirstMateInboxPanel`) are `question` items here; the panel goes from the Hub's
     screens.
   - Settings › Decisions keeps only the answered history, renamed "Past decisions" (WP-214 moves it).
   - The delivery gate's cards are `check` items.
5. **The tracker feed.** Review requests on Ash's own projects' repos are already `review` items (WP-210). The rest
   of upstream's tracker inbox (GitHub, GitLab, Jira and Linear activity) leaves the Hub: the Hub routes Inbox to this
   screen, and upstream's InboxView stays for the non-Hub build. Any tracker account set in Settings keeps working.
   Only the screen changes.
6. **Empty.** "Nothing needs you." and one line with a link to Home.

## Done when

- [ ] Tests:
  - the groups and chip counts equal WP-210's counts;
  - each kind's buttons call its own handler, and the row leaves on answer;
  - opening from a project's chip filters to it;
  - no tracker item from a repo outside Ash's projects shows;
  - `FirstMateInboxPanel`'s questions appear here and nowhere else in the Hub.
- [ ] Browser spec `tests/browser/wp211-needs-you.spec.ts` with example data matching `NeedsYou.png`: filtering,
  answering one of each kind, the project filter and the empty state, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data), and the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-211/`, never pushed).
- [ ] `npm run check` passes.
