# WP-190: A skill router that picks one skill per message, in code

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 41, 45 | yes |

From PLAN.md, "From oh-my-hermes", item 5 (a deterministic skill router). oh-my-hermes is MIT (read at commit
`2676c33`); idea only, credited per SOURCES.md.

## Goal

When the person's message clearly matches a skill ("review this diff", "this test is flaky"), code picks that one skill
and puts one line in the turn pointing to it. When nothing clearly matches, nothing is added. The same message always
picks the same skill, and the person can see why.

## What Hivra has

- `src/features/plugins/model/pstackAutopilot.ts`: `sessionInstruction` puts an always-on index of every pstack and
  mcode skill (`pstackIndex.generated.json`, `mcodeIndex.generated.json`, `indexLines`) into the system prompt with
  `PSTACK_AUTOPILOT` ("When the work matches a skill below, read its SKILL.md and follow it yourself"). The model
  decides which, every turn, from the whole list.
- `src-tauri/src/skills.rs` `list_skills` and each skill's frontmatter (`name`, `description`).
- Memory recall already places text inside a turn, fenced, without touching the system prompt
  (`src/features/memory/model/recall.ts`); the router uses the same place.
- `rankSkills` and `fuzzyMatch` (`src/features/skills/model/slashCommands.ts`) rank by name for the slash picker; they
  are not a router.

## What to build

1. **Routes as data.** Each indexed skill may carry `route` in its index entry: `phrases` (whole phrases, lower case),
   `tokens` (single words with a weight), `not` (phrases that block it, for example "don't review"). A skill's own
   frontmatter may carry a `route:` block. pstack and mcode skills are vendored and not edited, so their routes live in
   one Hivra file, `src/features/skills/model/routes.json`, keyed by plugin and skill name, which the index generators
   merge in. Skills without a route are never routed.
2. **The router** (`src/features/skills/model/router.ts`, pure): `routeMessage(text, routes)` returns
   `{ skill, score, matched }` or `none` with a reason. A phrase match scores 3, each token its weight; a `not` phrase
   removes that skill; below a threshold (default 3) is `none`; a tie between two skills is `none` ("two skills
   matched equally"). Code blocks and quoted text in the message are ignored. Text is normalized (case, spacing,
   Unicode quotes) the same way every time.
3. **In the turn.** With the router on, the session instruction keeps one short sentence instead of the full index
   ("A line in your turn may name one skill to use"), and a routed message gets one fenced line: "For this message use
   the skill `diagnose`: read <path>." The slash command and a named skill still win over the router.
4. **Why.** The chat's message menu gains "Why this skill?", showing the matched words and score, or why none matched.
5. **Setting:** Settings > Plugins > "Skills for each message": "List them all" (today, the default) or "Pick one per
   message".

## Rules

- Off by default: "List them all" keeps today's instruction byte for byte (tested).
- No model call in the router; it runs in under a millisecond for 500 skills (a test asserts the bound).
- No new outward network call. A routed skill gets no extra permission; approvals and the protected-path list
  (`src/shared/security/agentConfigPaths.json`, when it exists) are unchanged.
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row in SOURCES.md.
- Upstream rules from PLAN.md: new files; `pstackAutopilot.ts` gets a branch, not a rewrite.

## Done when

- [ ] Red first: a table of messages and expected picks written before the router, with negative controls: "don't
      review this", a message whose only match is inside a code block, a tie, a greeting, and a message that names a
      slash command all give `none`.
- [ ] Tests: the same text gives the same pick every time; Unicode quotes and spacing do not change it; the generators
      merge `routes.json` and frontmatter routes; the 500-skill timing bound.
- [ ] Test: with the setting off the session instruction is unchanged; with it on, a routed turn carries one fenced
      line and an unrouted turn carries none.
- [ ] Browser spec `tests/browser/skill-router.spec.ts`: switch the setting, send a matching message (stub provider),
      open "Why this skill?". Screenshot in the PR.
- [ ] `npm run check` passes.

## Not in this package

Routing to plugins' MCP tools. A model-based router. Routes for skills outside pstack and mcode (their authors can add
a `route:` block later).
