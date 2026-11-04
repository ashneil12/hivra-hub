# WP-73: Home

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | 70, 72 | yes |

## Goal

One quiet screen that shows, at a glance, what is moving, what needs the person, and what they touched last.

## Why

Ash, 4 Nov: liked Orbit's home. WP-06 retired Today, Being built and Needs you because they were busy and robotic.
This is their replacement and has to be the opposite: a few plain lines, each one a link.

## Read first

- Orbit `apps/web/src/features/home/pages/HomePage.tsx` and `.ai/FEATURES.md` "Home" (a greeting, then a few cards
  with a staggered entrance; no New menu on Home).
- WP-06 (what was retired and why), WP-14 (decisions and questions), WP-15 (Inbox), WP-70, WP-72.

## Build

1. **Home** at the top of the rail, above the projects.
2. **Three short sections**, each hidden when it is empty:
   - **Needs you**: open decisions and questions, and tasks waiting in review. One line each, oldest first.
   - **Moving now**: agent tasks in progress across projects. One line each: the project, the task and who is on
     it, live from `tasks://changed`.
   - **Recent**: the last few docs and chats the person opened.
3. **Empty state**: one line ("All quiet.") and a box to start a chat with a project's coding team.
4. **Opening the app**: Home when something needs the person, otherwise where they were.
5. No counters, charts, badges or status chips. Plain words and links only.

Port Orbit's layout and entrance animation, restyled in Hivra's theme.

## Done when

- [ ] Browser specs with seeded data: each section shows and hides; a task moving changes Moving now live; clicking
      a line opens the right place; the empty state. Screenshots in the PR.
- [ ] `npm run check` passes.
