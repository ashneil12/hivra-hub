# WP-218: Departments beyond coding

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | M | WP-213 (the first mate chips), WP-215 (handoffs and decision levels), WP-176 (spend limits) | yes |

## Goal

A project can have more first mates than Coding: Marketing, Ops, Research, Design, or one Ash names himself. Each is a
department with its own first mate, a charter that says what it decides and when it passes up, and a budget. The
captain hands work to the right one, and proposes a new department when it keeps doing a kind of work no department
covers.

## Why

Ash, 11 Nov 05:33: "first mates are like department leads. Think coding, marketing etc. and then the crew are the ones
under them." In 0.16.15 the only first mate was each project's Lead (the coding team); other Monos on a project were a
list of names with no role.

## Read first

- [UX.md](../UX.md) "The chain of command" and "The places"; the journey doc's "Who decides what".
- WP-213's chips (they read project memberships until this lands), WP-215's `captain.handoff`, WP-176's limits.
- The Mono templates (WP-05), project memberships (`hub/model/localHub/`), `hub/model/leadRoleName.ts`.

## Build

1. **A department.** Stored in the app's own hub data (a `departments` document beside memberships): its name, the
   project(s) it serves, its first mate (a Mono), its charter and its budget. Coding is built in: each project's Lead
   is its Coding first mate and needs no row.
2. **Templates.** Marketing, Ops, Research and Design ship as Mono templates, each with a charter: what it decides on
   its own (order of work, which crew, retries, spending inside its budget), what it passes up (crossing departments,
   over budget, a red line, not confident), and what it may never do (publish or send in Ash's name: always Ash's).
3. **Add a department.** The chips' "+ Add a department" opens a short form: pick a template or "Your own" (a name, one
   sentence on what it does, an engine). "Your own" writes a charter from the same frame with that sentence in it. The
   new first mate starts with no crew.
4. **Routing.** `captain.handoff` picks the department whose charter fits when none is named, Coding when unsure, and
   says which in its one line. A first mate hands work across departments only through the captain.
5. **Budgets.** Each department has a daily and weekly spend limit that extends WP-176's limits. Near the limit it
   warns once in its chat; at the limit it starts no new crew and passes up (money past a limit is always Ash's).
6. **The captain proposes.** When the captain has done the same kind of work itself three times with no department to
   hand it to, it proposes one in the next owner batch: "Add a Marketing first mate for SafeTube? a) yes b) not now c)
   never for this". Yes adds it from the template.
7. **The chips read departments.** WP-213's chips show each department's first mate by department name; memberships
   without a department keep showing by the Mono's own name.

## Done when

- [ ] Tests:
  - departments round-trip; Coding is each project's Lead with no row; no chip appears twice;
  - each template's charter names what it decides, passes up and never does; "Your own" builds one from the sentence;
  - routing picks by charter, falls back to Coding, and a cross-department handoff goes through the captain;
  - a budget warns once, stops new crew at the limit and passes up;
  - the proposal appears after three self-handled asks of one kind and yes adds the department.
- [ ] Browser spec `tests/browser/wp218-departments.spec.ts` with example data: adding Marketing from the chips, its
  chip and side chat, and the budget warning, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data); the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-218/`, never pushed).
- [ ] `npm run check` passes.
