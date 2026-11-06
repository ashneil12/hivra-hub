# Real conversations (`npm run hub:realconv`)

This tests one thing: would someone reading the transcript call it a real conversation? It runs Alfred's scenes S1 to
S17 (`/workspace/hub-qa/mono-homes/real-conversation-tests.md`, copied into `tests/realconv/scenes.json`) against the
real hub. A tester model plays Ash. A judge model scores every scene with Alfred's rubric.

How it differs from the other two benches:

| Bench | Agents | Ash's side | What a PASS means |
| --- | --- | --- | --- |
| `hub:verify-live` | scripted fake Claude | scripted | **The wiring works**: delegation rows, restarts, queues, routing, goals. Nothing about behaviour. Its verdict.json says `"scope": "wiring"`. |
| `hub:realtest` | real Claude (Sonnet) | scripted lines from a scenario file | The rule metrics and the realtest grader |
| `hub:realconv` | the real model the hub is set to (Claude, or a custom model through the hub's router) | **a tester model in Ash's voice**, reacting to what the agents actually said | Alfred's verdict, with hard checks from the hub's state. Only counts when every part was a real model. |

## Run it (on the Mac)

```bash
npm run hub:realconv -- --list                                   # scenes, and which can't run yet
npm run hub:realconv -- --scenes S10,S5,S14 --dry-run            # check options, print the plan, start nothing
npm run hub:realconv -- --scenes S10,S5,S14                      # agents, tester and judge on DeepSeek V4.1 Flash (the default)
npm run hub:realconv -- --scenes S5 --no-build                   # reuse target/debug/monocode
```

**Tester and judge off Ash's Claude limit.** Use any OpenAI-compatible provider: `xai`, `deepseek`, `openrouter`,
`ollama`, `openai`, or `custom` with `--*-base-url`. The key is read only from the variable you name. The runner never
looks for a key by itself.

```bash
export XAI_API_KEY=...        # in your own shell
npm run hub:realconv -- --scenes S10 \
  --tester xai --tester-model grok-4 --tester-key-env XAI_API_KEY \
  --judge deepseek --judge-model deepseek-chat --judge-key-env DEEPSEEK_API_KEY
```

**Agents on a custom model.** The agents' model is whatever `--agents` says. The default is `deepseek-sub` (Ash, 27 Oct:
no test or run may use his Claude subscription), and the tester and judge follow it. `claude:<model>` runs only when someone passes it, held to Sonnet and medium effort by the bench's `claude`
(and the tester and judge still stay on DeepSeek unless named). `--agents grok-sub` points the hub's chats at
`~/.local/bin/claude-grok` (Claude Code on Grok through the local gateway). The tester and the judge stay on DeepSeek
unless you name them, and the launcher is started with no `ANTHROPIC_*` or `CLAUDE_CODE_*` credential variables from
this shell.

**Everything on OpenRouter.** `--agents openrouter-sub` points the hub's chats at Ash's launcher
`~/.local/bin/claude-openrouter` (Claude Code on OpenRouter; it reads its own key from the Keychain and rewrites every
`--model` to its own default). On its own it is a bridge like `grok-sub`: the tester and the judge stay on DeepSeek
unless you name them.

A bench chat runs inside a seatbelt that closes the real home (so no Keychain) and allows outbound connections only to
loopback ports this run names. The launcher dials OpenRouter directly, so inside that fence it cannot read its own key.
The runner therefore starts a loopback relay of its own — `scripts/bench-or-relay.mjs`, outside the sandbox — which holds
the key, and the launcher is handed only that relay's URL and a token for the run. The profile opens exactly that one
port, so the gateway ports the DeepSeek and Grok bridges use stay shut. The key is never written to an environment, a
file, a log line or an error message, and never into the headers of an answer the relay hands back (the answer's body is
streamed through untouched, which is what keeps a streamed answer intact); with no `hivra-openrouter` Keychain item the
run stops before it starts, and says how to add it. Every chat is still started with no `ANTHROPIC_*` or
`CLAUDE_CODE_*` credential variables from this shell.

```bash
npm run hub:realconv -- --scenes S10,S5,S14 --agents openrouter-sub --tester openrouter-sub --judge openrouter-sub
```

One gap, unchanged here: the tester and the judge are the runner's own children and are started under the same seatbelt,
so naming `openrouter-sub` for one of *them* runs its launcher inside the fence, where it has no Keychain and no relay —
the relay is the chats' route only. A tester or judge on an OpenAI-compatible provider you name (`xai`, `openrouter`,
`deepseek`, …) with `--*-key-env` needs no Keychain and is the way to move them off DeepSeek today.

With `custom:<id>`, the hub runs its chats through its own model
router, exactly as it does when you pick that model:

```bash
npm run hub:realconv -- --scenes S5 --agents custom:grok --custom-model ~/grok-model.json
```

- `~/grok-model.json` holds only the model's settings, as the hub's setup export has them:
  `{"id":"grok","name":"Grok","provider":"xai","baseUrl":"https://api.x.ai/v1","modelId":"grok-4"}`. A file with a
  key in it is refused.
- The key is the one you saved in a dev copy's Other models. That's the Keychain item `monocode-hub-dev:model-key`,
  account = the model id, which every dev copy shares.
- Use the same `id` in the file as in the dev copy, or the router finds no key and the chat says so.
- The bench's `claude` leaves a routed chat's model and effort alone (`isRouted`). Your Claude limit is then spent only
  on the app's Haiku helper calls, so its 5-hour and 7-day guards are logged but not enforced.

Other flags:

- `--out <dir>`: where run folders go. The default is `evidence/realconv`.
- `--max-minutes`, `--max-turns`, `--keep`, `--slot`: as `hub:realtest`.
- `--scenes-file`: another scene book.

## What a run leaves

`evidence/realconv/<run>/` holds the bench's usual evidence: `run.log`, `events.ndjson`, `app.log`, the database copy,
and the project's git log. It also holds:

- `report.md` / `report.json`: one line per scene with its verdict and why, then the detail.
- `<scene>/transcript.md`: every line in time order, showing:
  - Ash's lines, with his own words marked;
  - room posts and chat replies;
  - worker chats, marked as not something Ash reads;
  - questions asked with buttons;
  - when something was stuck and whether Ash could see it;
  - the handoff rows;
  - the files changed;
  - the project's tests.
- `<scene>/evidence.json`, `<scene>/tester.ndjson` (every move the tester made, and the lines it was refused), and
  `<scene>/result.json` (hard checks, the judge's scores, the verdict).

## How a scene is played

The player is `scripts/realconv/player.mjs`. A permission card is answered by the bench, not the tester: a Read inside
the run's temporary HOME, the test project, or that Mono's memory folder is allowed, and anything else is refused.
The tester never answers Allow for a path outside the folders this run owns: that temporary HOME, the test project, that Mono's memory, and the run's other bench folders. A real-home read is also denied at the tool, so a
permission answer cannot open it. Each answer is logged with its path. An ask still open at the end is its own outcome,
`stuck on a permission ask: <path>`, not a plain fail.

1. **Setup.** Some scenes need something that happened earlier: S2's job to talk about, S4's past decision, S14's stuck
   `zod` install. That setup runs first through the realtest bench's scripted steps and is marked as setup.
2. **Opening.** Ash's opening from the card is sent verbatim, where the card says: the leadership room, the Lead's
   chat, a new coding-team chat, or the setup's chat.
3. **Follow-ups.** The tester answers each time the place has replied and gone quiet. It gets:
   - frank's "How Ash talks" openings and Alfred's voice notes (`tests/realconv/ash-voice.md`);
   - the scene card;
   - exactly what Ash can see;
   - whether something is busy or stuck.

   It answers with one move: send a line, wait, or done.
4. **Scripted lines are refused.** A line that tells an agent which file to read, what to reply or say, or that tags
   someone is sent back once. If the second try is scripted too, the scene is INVALID.
5. **Silent scenes.** S10 watches the room after the opening and Ash says nothing.
6. **Alfred's own lines.** S3's mid-work change of mind is sent as he wrote it, on time.
7. **Stuck work.** While something is stuck (a question, an approval, a failure, a pause, a handoff in `question` or
   `failed`), the player checks whether the window shows it. It also opens Today once per stuck chat, as Ash would.

## Checks and verdicts

Hard checks are in `scripts/realconv/checks.mjs`. They read the hub's state, never an agent's claim. Any automatic fail
fails the scene, whatever the judge says.

- `ack-only`: a bare acknowledgement ("Noted.", "Got it, on it.", "+1", NO_REPLY). `ack-loop`: the same ack three times.
- `scripted-reply`: a marker-style canned line.
- `handoff-no-chat-back`: a handoff with nothing said where Ash reads after it.
- `handoff-no-report-back`: a handoff that settled with nothing said after it.
- `stuck-invisible`: something sat stuck and no view ever showed it.
- `project-leak`: another project's facts, such as EXO's palette, turning up in Tally's scenes.
- `worker-in-room`: a worker posting in the leadership room.
- `bots-created-without-yes`: S15.
- Scene expectations, which count as missed scene checks:
  - seats speaking in the room;
  - seats talking to each other;
  - a handoff made;
  - files changed (new commits on any branch, edits in any checkout);
  - the diff mentions or avoids a word;
  - the project's own `npm test` passes, in the main checkout or a worker's;
  - the room going quiet.
- Facts are kept too: sessions the hub started, goals and whether each was kept.

**The judge** is `scripts/realconv/judge.mjs`. It is one call per scene, and gets:

- Alfred's rubric;
- the card;
- the transcript;
- the hard facts.

It scores every reply from 0 to 2 on five checks: answers, adds, disagrees, honest, voice. It also returns the scene
checks, any automatic fails it saw, whether this was a real conversation, and items/summary/problems in the realtest
grader's format.

**The verdict is computed, not taken from the judge:**

- **PASS**: no automatic fail, every scene check passes, the average reply score is at least 1.5, no reply scores 0 on
  "answers", and the judge calls it a real conversation.
- **PARTIAL**: no automatic fail, at most one check missed, and an average of at least 1.0.
- **FAIL**: anything else.
- **NOT-TRIGGERED**: the situation never arose. For example, nothing got stuck in S14.
- **INVALID**: the tester scripted.
- **UNGRADED**: the judge failed.
- **NOT-REAL**: the agents, the tester or the judge was the scripted fake (`--tester fake`, the runner's own tests).
  That is never a pass. The report shows what it would have scored as, and says "Not a real run" at the top.

## Scenes that can't run yet

- S9 needs two project Leads in one run, and the bench seats one test project.
- S17 needs work to carry on over days.

Both are kept with their reasons (`--list`).

## The runner's own tests

`node --test scripts/hub-realconv.test.mjs` covers:

- key handling;
- a real HTTP round trip to a fake OpenAI-compatible server, including the retry without `reasoning_effort`;
- the scripted-line lint over every line in the scene book;
- ack detection;
- every hard check;
- Alfred's verdict rules;
- that a fake can never pass;
- a whole two-scene run on a fake hub that writes the report folder.

`src/app/model/verifyDriver.customModel.test.ts` covers the window's `customModel` step. It adds a model with every
level and refuses anything carrying a key.

