# WP-45: pstack autopilot and plain-English endings

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| B | S | 10, 41 | yes |

## Goal

pstack works by itself: agents pick and follow the right pstack skill without anyone typing a slash command. Every
agent ends its replies and work reports with one plain-English paragraph.

## Why

Ash, 4 Nov 02:17: pstack is "too complex even for me"; there are no slash commands he would think to use, so it
should activate itself when needed, suggest things, or just do them. And: "at the end of every message or work that's
done, it should just drop a paragraph ... a plain English explanation". 57 of pstack's 59 skills set
`disable-model-invocation: true`, so Claude Code never runs them on its own.

## Build

1. **pstack stays byte-identical to its pin.** Nothing under `src-tauri/plugins/pstack` changes and the flag is not
   flipped.
2. **Index:** generated from each pstack `SKILL.md` frontmatter (skill, what it is for, when to reach for it, the
   path of its `SKILL.md` in the installed plugin). A test fails if a skill is missing from it. Keep it compact and
   state its token size in the PR.
3. **Always on:** every Claude Code and Codex session where pstack is on gets a short instruction plus the index
   through the existing session-instruction path: when the work matches a skill, read its `SKILL.md` and follow it,
   say in one plain sentence which one was used, and suggest one when it clearly helps. Switching pstack off removes
   both.
4. **Briefs:** the first-mate brief scaffold (WP-10) names the relevant pstack skills by task type (code: verify and
   test skills; design: the design ones), as a small table in code with a test.
5. **Plain-English endings,** on by default with a Settings switch: one line in the first-mate contract and the same
   session instruction. Every reply that reports work or answers a question ends with one short plain-English
   paragraph; worker reports end the same way and first mates pass it through to the person.

## Done when

- [ ] Tests: the index covers every pstack skill; the instruction and index reach Claude Code and Codex sessions and
      go when pstack is off; briefs name skills by task type; the contract line and session instruction are present
      and the Settings switch removes both.
- [ ] Browser spec for the Settings switch; `npm run check` passes.
