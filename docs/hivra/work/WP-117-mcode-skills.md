# WP-117: MiniMax Code team skills for dispatch, independent review, and turning taste into checks

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | M | none | yes |

## Goal

A first mate can call, by name, a small set of skills the MiniMax Code team actually uses: whether work should go to a subagent at all, a review of a diff from a clean context, and turning a repeated correction into a test, lint, hook or CI step. They install as ordinary Hivra skills, called by name only, with credit.

## Why

A 9 Nov find: [MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack) (MIT, "Copyright (c) 2026 MiniMax Code", 583 stars on 9 Nov, created 28 Oct, pushed 6 Nov, commit `88f84be` on the clone used for this draft). It is the team's own workflows, not a prompt pack. The pieces Hivra still lacks are:

- `subagent-split-check`: split to a subagent only when there is a measured context reason, parallel disposable work, or a tool/instruction conflict. Default is one main loop.
- `independent-review`: a reviewer that sees only the diff, the requirement, and the test results, not the author's conversation.
- `taste-to-checks`: if we tell an agent the same thing twice, the second time is our fault; encode it as a test, lint, hook or CI step.

Hivra already has crew routing (WP-13), completion gates (WP-40), the no-mistakes delivery gate (WP-81), and Matt Pocock's diagnosing-bugs, rpi-tdd and grill-me (WP-84). These MiniMax skills do not replace those. They sit next to them and are called by name, the same way WP-84 copied Matt's skills.

Also useful, if each is a short copy: `long-session-check` and `context-tax-audit`. Skip the MiniMax-specific stacks (`jiachen` content pipeline, `req-tpm`).

## Read first

- mcode-stack at `88f84be` (or a later pin you record): `README.md` "What's inside", `stacks/ronny/skills/subagent-split-check/SKILL.md`, `independent-review/SKILL.md`, `taste-to-checks/SKILL.md`, and optionally `long-session-check/SKILL.md` and `context-tax-audit/SKILL.md`. Licence: `LICENSE`, "Copyright (c) 2026 MiniMax Code".
- Hivra: how WP-84 installed Matt Pocock's skills (`docs/hivra/credits.json`, skills under the first-mate or skills tree), plugin/skill install (WP-30/31), crew routing (WP-13), gates (WP-40), delivery gate (WP-81). Do not hook a skill into autopilot or merge authority.

## Build

1. **Copy the three skills** (and the two optional ones if you take them) as Hivra skills, called by name only. Keep each skill's text, with a file header naming the source path, MIT, "Copyright (c) 2026 MiniMax Code", commit `88f84be` (or your pin), and what you changed (usually: Hivra names, no MiniMax product branding). Do not copy `stacks/jiachen` or `stacks/req-tpm`.
2. **Wire by name.** A first mate or a delivery/review step can invoke `subagent-split-check` before spawning crew, `independent-review` as a clean-context review of a finished diff, and `taste-to-checks` when the same correction has been made twice. Follow the existing "called by name only" pattern from WP-84. If a hook would need more than a small change in a hot file, leave the skills installable and document the manual call in PR.md.
3. **Credits.** Add a sources row and a credits.json component (and a NOTICE entry if that is what credits.test.ts expects for copied MIT text), then the README inspirations list. Run `npx vitest run src/features/settings/model/credits.test.ts`.
4. **Tests.** At least: the skills are listed and load; names are stable; independent-review's brief to a reviewer contains only diff, requirement and test results (a unit test on the wrapper that builds that brief, if you add one); no skill is auto-run on merge.

## Copy with credit

- Source: [MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack), MIT, "Copyright (c) 2026 MiniMax Code", pin `88f84be` unless you record a newer one.
- Credit the copied skills, not the whole marketplace or the MiniMax Code product name as if Hivra were that product.

## Done when

- [ ] The three named skills are in the tree, loadable, and credited.
- [ ] `independent-review` is set up so a reviewer does not inherit the author's conversation.
- [ ] `credits.test.ts` is green; SOURCES.md and README inspirations list are updated.
- [ ] No em dashes or en dashes in any text a person sees.
