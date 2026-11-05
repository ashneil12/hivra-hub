# WP-84 real-model check (5 Nov)

Two phases, run for real, non-interactively (`-p`) on DeepSeek V4.1 Flash through `~/.local/bin/claude-deepseek`, inside the bench's seatbelt profile (`scripts/bench-sandbox.mjs` `agentCommand`, as merged in #77).

- Task record: `{"id":"tally-archive","title":"Archive a tally instead of deleting it", …}` (a JSON record, not free text).
- Prompts: printed by `node scripts/rpi-phase-prompt.mjs --phase research|outline --record task.json --repo <this checkout>`, the same code path the app uses. One line was changed by hand: "The code is in <hivra checkout>" became "The code is in <the throwaway Tally repo>", because the script uses `--repo` both for loading the prompt code and for that line (the app passes the project's cwd there). That's a script fix to make: a separate `--project`.
- Project: a fresh copy of tests/realtest/tally, git-initialised, with no remote. `git status` was clean after both runs.
- First tool call in each transcript: `Bash: echo ok` (the shell works under the sandbox).
- research: 29 tool calls, result "success", 21.5 KB → research.md
- outline (create-structure-outline): 36 tool calls, result "success", 19.2 KB → outline.md
- Both cite real Tally files with lines (e.g. packages/api/src/server.ts:24, stats.ts:13), follow the skill's template shape, and contain no "please provide" or "wait for the user" text.

Full transcripts (2.7 MB and 4.9 MB of stream-json) are kept on the Mac at ~/Worktrees/hivra-tests/wp84-rpi-run-20261105/.
