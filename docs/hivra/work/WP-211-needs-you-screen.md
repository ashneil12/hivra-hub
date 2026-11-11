# WP-211: The Decisions place

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-210, WP-213; start after PRs #213, #220 and #225 merge (they change `FirstMateInboxPanel`) | yes |

## Goal

One place, **Decisions** on the rail, shows everything that needs Ash and everything decided for him. On top: Needs
you, grouped by project, each answered where it stands. Under it: **Decided for you**, newest first, each with who
decided, why, and **Overturn**. Then his own past answers. A line at the top keeps score. It replaces the Inbox in the
Hub and Settings › Decisions. The Needs you part matches [ux/mockups/NeedsYou.png](../ux/mockups/NeedsYou.png).

## Why

Ash, 11 Nov 05:33: the captain should make "95-99% of all decisions for you", first mates most of the rest, so "the
owner gets 1% of those", with "decisions minimal and important when it needs you and things ... kept track". That only
works if Ash can see what was decided for him and undo it in one tap, and if the share that reaches him is measured. In
0.16.15 the Inbox showed someone else's GitHub activity, the first mate's questions lived in `FirstMateInboxPanel`,
Settings had a Decisions page for the same thing, and nothing showed decisions made for him.

## Read first

- [UX.md](../UX.md) "The chain of command", "The places", "One list: Needs you"; WP-210's `needsYou.ts`.
- The decision store: `src-tauri/src/decisions.rs` (`answer`, `answered_by`, `person_only`, the work log line) and its
  webview side (`hub/model/localHub/decisions.ts`, `firstmate/model/steering.ts`). Today `answered_by` holds `person` or
  `user` (Ash), `chat:<session>` (an agent in its own chat), `page:<id>` (a Page, PR #235) and the app's closer.
- `inbox/ui/InboxView.tsx` and `inbox/model/*` (keep the code for upstream; route around it in the Hub),
  `crew/ui/FirstMateInboxPanel.tsx`, the Settings › Decisions section, `delivery-gate/ui/GateCards.tsx`.

## Build

1. **Who decided.** One function maps `answered_by` to a level and a name: Ash ("You"); `captain:<mono>` (WP-215) the
   Chief of Staff; `chat:<session>` of a project's Lead or a first mate Mono, that first mate by department name;
   `page:<id>` the Page by name; a standing answer (WP-156) "Standing answer"; anything else "The app". Unit-tested on
   every value the store writes today.
2. **The reason.** Add `answer_reason` (short text, optional) to a decision: a migration on the `decisions` table and the
   field through `answer` and the webview types. Callers that know why (WP-156's standing answers, WP-215's captain)
   fill it; others leave it empty and the row shows no reason. No secrets: run the reason through the existing secret
   patterns and refuse it like any other field.
3. **Overturn.** A store function `overturn(project, key, answer, now)`: only for an answered decision not answered by
   Ash, and never for a person-only key (they are always Ash's already). It keeps the old answer and who gave it in
   `overturned_from` and `overturned_by` (new columns), sets the new answer as Ash's, bumps the version, writes the work
   log line, and tells the asker in its chat ("Ash changed the answer from X to Y"). The waiting tasks that were released
   are told the same. A decision is overturned at most once from the screen; after that it is Ash's like any other.
4. **The screen**, top to bottom:
   - **The score line**, for the last 7 days, from the store: "1,240 decisions · 12 reached you (1%) · you overturned
     3". Counted by level from item 1; a week with no decisions hides it.
   - **Needs you**, as WP-210's list: filter chips by kind with counts (All, Stopped, Questions, Approvals, Ready to
     merge, Reviews, Checks; a chip with zero hidden); groups by project in rail order, each row with its kind chip,
     sentence, "<who> · <age>" and its actions (the primary blue). Answering in place uses the item's own handler; a
     free-text question gets a "Reply" box. Opened from a project's glance column, it starts filtered to that project
     with a removable chip naming it. Empty: "Nothing needs you."
   - **Decided for you**, newest first, 20 at a time with "Show more": each row "<who> <decided what>", a grey line
     "<reason> · <project> · <age>", and **Overturn**, which opens a small inline form with the decision's options (and
     a text box) and calls item 3.
   - **Your answers**: Ash's own past answers, newest first (what Settings › Decisions showed). It is history only.
5. **Fold in.** The first mate's questions (`FirstMateInboxPanel`) are `question` items here and the panel goes from the
   Hub's screens. Settings › Decisions goes (its history is "Your answers"). The delivery gate's cards are `check` items.
6. **The tracker feed.** Review requests on Ash's own repos are already `review` items (WP-210). The rest of upstream's
   tracker inbox leaves the Hub: the Hub routes Inbox and the rail's Decisions to this screen; upstream's InboxView stays
   for the non-Hub build; tracker accounts set in Settings keep working.

## Done when

- [ ] Tests:
  - the level mapping covers every `answered_by` the store writes, and unknown values read "The app";
  - `answer_reason` round-trips, is optional, and a key-shaped reason is refused;
  - overturn: refused for Ash's own answers and person-only keys, keeps the old answer and who, tells the asker and the
    released tasks once, and a second overturn from the screen is refused;
  - the score line counts by level and equals the rows;
  - the Needs you groups and chip counts equal WP-210's; each kind's buttons call its own handler and the row leaves on
    answer; opening from a project filters to it;
  - no tracker item from a repo outside Ash's projects shows; `FirstMateInboxPanel`'s questions appear here and
    nowhere else in the Hub.
- [ ] Browser spec `tests/browser/wp211-decisions.spec.ts` with example data: filtering, answering one of each kind,
  the project filter, an overturn, the score line and the empty state, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data), and the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-211/`, never pushed).
- [ ] `npm run check` passes.
