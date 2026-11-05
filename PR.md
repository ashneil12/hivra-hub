# Benches: answer permission asks, and add `--agents grok-sub`

Two commits on `fix/bench-permission-asks`:

- `8fb55932` Benches: answer a permission ask, and record one still open
- `9df2abca` Benches: add --agents grok-sub on the local gateway

The live benches were not run. This Mac's `~/.local/bin/claude-grok` was not read.

## What changed

A permission card is answered by the bench, not the tester. A Read is allowed only when every path, resolved lexically, sits inside the run's temporary HOME, the test project's folder, or that Mono's memory folder (`dataDir/monos/<id>`). Anything else is refused: another tool, a path outside, a name that only starts like the root, `..` that leaves, a relative path with no cwd, an empty path, a Windows path, a `->` path, and a symlink or a symlink on the way. `.` and `..` are resolved lexically. A symlink is never followed and never realpath'd. A root shallower than two segments (`/` or `/tmp`) allows nothing.

The window snapshot lists each open card (`permissionAsks`: request id, tool, paths, command). Approve with a request id touches only that card. `decision: "deny"` denies it; anything else allows it. An approve step with no request id still Allows every waiting card. Each answer is in the scene evidence (`permissionAnswers`) and on the transcript as `permission allow: <path>` or `permission refuse: <path>`. An ask still on the ending snapshot replaces the verdict with `stuck on a permission ask: <path>`.

`--agents grok-sub` points the hub's chats at `~/.local/bin/claude-grok`. Presence is `access` with the executable bit; the file is never read. A missing launcher is a plain-words error. DeepSeek stays the default. The grader, the tester and the judge stay on DeepSeek unless named. Grok keeps the book's model. The plan flag is `launcher: true`, never `deepseek: true`, so models are not rewritten. The launcher's child is started with the caller's `ANTHROPIC_*` variables removed, and `CLAUDE_CODE_*` names that are keys, tokens, secrets or other credentials removed. `CLAUDE_CODE_SUBAGENT_MODEL` stays. A Haiku or DeepSeek run is not stripped.

## Done when

**Allow a Read inside the temporary HOME, the test project, or that Mono's memory, and refuse anything else.** Met. `scripts/realconv/permissions.mjs`, called from the player with `ctx.home`, `ctx.project` and `dataDir/monos/<id>`. Nine tests in `scripts/hub-realconv-permissions.test.mjs`: inside those three folders; outside and a longer name (`/tmp/home-evil`); `..` that stays in and `..` that leaves; a relative path with and without a cwd; a non-Read and a Read that mixes an outside path; an empty path, a `->` path and a Windows path; a symlink and a symlink ancestor, including a check that throws; `/` and `/tmp` allow nothing.

**Answer through the window driver, and log the path and the decision.** Met. `pendingPermissionAsks` is on the snapshot. Approve takes `decision` and `requestId` (`verifyDriver.ts`; the App.tsx hook forwards the decision). The fake scene writes `permissionAnswers` and a transcript line `permission refuse: /etc/passwd` (`scripts/hub-realconv.test.mjs`).

**An ask still open at the end is `stuck on a permission ask: <path>`, not a plain FAIL.** Met. The same fake scene, whose snapshot keeps returning a Read of `/etc/passwd`, ends as `stuck on a permission ask: /etc/passwd`.

**`--agents grok-sub` points at the Grok launcher, presence only, and DeepSeek stays the default.** Met. `grokBridge` uses `accessSync` and is tested against a temp fake file, never the real launcher (`scripts/hub-realtest.test.mjs`). A missing file throws the plain-words error. With no flag, `benchAgents` still sets `deepseekSub`. The realconv dry run names Grok for the chats and DeepSeek for the tester and the judge (`scripts/hub-realconv.test.mjs`).

**The grader and the tester stay on DeepSeek unless named.** Met. `graderUsesDeepSeek` is true for grok-sub. Naming `--judge claude` is the only thing that moves the judge.

**The launcher's child gets no caller credential variables.** Met. `childEnv` drops `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the other sign-in names, and keeps `PATH` and `CLAUDE_CODE_SUBAGENT_MODEL`. A non-Grok child is unchanged. The wrapper exports `REALTEST_GROK_SUB=1` only for a Grok run. Both spawns of the real binary use that environment.

**The plan does not call Grok DeepSeek.** Met. `planFlags({ grokSub: true })` is `{ launcher: true }`. Rust parses `launcher` and refuses it without `claudeBinary`. `window_info` sets `launcher` and not `deepseek` (`a_bench_on_a_gateway_launcher_says_so_without_calling_it_deepseek`). `claudeBridgeKind` stays undefined for `{ launcher: true }`, so models are not rewritten; sign-in is still skipped.

**Docs.** Met. `docs/REALTEST.md` and `docs/REALCONV.md` name the option, the launcher path, who stays on DeepSeek, the credential strip, and the stuck outcome.

## Commands

`npm run check` (vitest, tsc, script tests, `cargo fmt --check`, clippy `-D warnings`, `cargo test`):

- vitest: 1129 files passed, 2 skipped; 9233 tests passed, 13 skipped
- tsc: passed (the script tests started after it)
- script tests: 332 passed, 0 failed, 2 skipped
- Rust lib tests: 1669 passed, 0 failed, 2 ignored, including the launcher plan test
- fmt and clippy passed (cargo test ran only after both)

`cargo test --doc --workspace` afterwards, because the check log was cut off as the doc-tests started: 2 suites, 0 failed.

## Not checked

The live benches (`hub:realtest`, `hub:realconv`) were not run, on purpose. A real scene is the check that a card disappears after Allow or Deny and that a Grok chat actually starts. The stuck outcome is keyed off the ending snapshot, so a card the window accepted but the provider has not acknowledged yet is still "stuck". That matches "still open at the end".

The symlink check in the player is `fs.lstatSync` and does not follow the link. The unit tests use a stand-in, so they do not need a Mac. A real symlink under the temporary HOME is the Mac check.

## Process control and the real home

Three more commits on `fix/bench-permission-asks`:

- `9c26bfdd` Benches: deny process control and the real home to every agent
- `a647fd8b` Benches: fail the round when a real app disappears
- `489b7952` Benches: never Allow a path outside the bench

The live benches were not run.

### What changed

Bench agents still get `bypassPermissions`. The fence is deny rules plus a PreToolUse hook, not a change to the app's own permission rules. The rules are written to `<tmp HOME>/.monocode-hub-bench/settings.json` and passed as `--settings` and `--disallowedTools`. `~/.monocode-hub-dev/claude-config` and `~/.claude` are not written; `writeBenchSettings` throws if the target is inside either.

Denied for every bench agent (the DeepSeek launcher, grok-sub, claude, and haiku-test, all through `scripts/hub-realtest-claude.mjs`): `kill`, `pkill`, `killall`, `osascript`, `open`, `shutdown`, `reboot`, and `launchctl` except `launchctl list`. The same check covers `/bin/kill`, `command kill`, `xargs kill`, `$(which kill)`, a backtick `which`, `sh -c`, and `kill` after `;`, `&&`, `|`, `&`, or inside `$(…)`. There is no exception for a child pid. A chat whose spawn is missing the rules or the settings file is not started.

Writes (`rm`, `mv`, `cp`, `ln`, `mkdir`, `touch`, `tee`, `chmod`, and redirection) outside the run's own folders are denied. Reads of `~/Library/Application Support` outside the dev copy's folder, of `/Applications`, and of the real home outside the bench folders are denied. A permission answer of Allow does not open them: the hook exits 2 anyway. A symlink inside the bench whose target is outside is denied too. `cat /etc/passwd` is still allowed.

The one process an agent may stop is the bench dummy, and only through `stop_bench_dummy`, which checks the recorded pid's command still carries the marker. S1 now says "the bench dummy should be stopped" and fails unless that tool stopped it. The card's "grok bot transcripts" line now says "the bench's own transcript". The benchmark's room line no longer names Grok Bot.

Around every scene the run snapshots processes whose executable is under `/Applications` or the real home's `Applications`. If one of those names is missing afterwards, the scene is FAIL with `touched a real app: <name>`, `claude/stop` is written, later scenes are skipped, and the run exits non-zero. A `ps` failure does not fail the scene. Cleanup does not replace that stop reason with "run ended".

The tester refuses Allow, Allow once, and Always allow when the card names a path outside the folders this run owns. No ask at all is refused too.

### Done when

**Every bench agent's spawn args and config carry the deny rules, and a chat without them is not spawned.** Met. `prepareBenchSpawn` for a normal chat, `REALTEST_GROK_SUB=1`, and `REALTEST_HAIKU_TEST=1` keeps `Bash(printenv)` first and then every `benchDenyRules` string, and points `--settings` at the bench file (`scripts/bench-guard.test.mjs`). The same test spawns the wrapper with a fake `claude` that only touches a marker: with no settings file the marker is absent and the status is non-zero, for all three. `--version` is left alone. The haiku "no key" test still exits before Claude starts.

**A real-home read stays denied when a permission answer allows it.** Met. `callBlocked` and `rulesBlock` on a Read of `/Users/<user>/agent-memory/ash/MEMORY.md` with `permission: "allow"` are true. The hook, given that Read, exits 2. The file is not read. The tester test refuses Allow and Allow once for that path, refuses Always allow when the card has no ask, and allows a Read inside the bench project (`scripts/hub-realconv-permissions.test.mjs`).

**A missing real app fails the scene and stops the round.** Met. A fake `ps` listing names `Grok Bot` and `Notes` and does not name an app under the temporary home. Dropping `Grok Bot` gives exactly `touched a real app: Grok Bot`, and `finishSceneApps` calls the stop with that reason. The same name still present, or a `ps` that threw, does not fail. `exitCodeForStop` is 1 only for that reason. The scenario return and the realconv verdict both carry the FAIL, and a later scene is skipped while that reason is set.

**The scene book names no real app.** Met. `scanSceneBook` over `tests/realconv/scenes.json`, `tests/realtest/benchmark.json`, and `tests/realtest/scenarios/*.json` returns no hits. The same test fails on "hermes" and on "grok bot".

**The bench tool stops only the dummy it recorded.** Met. A node process whose command does not carry the marker is left alive (`process.kill(pid, 0)`), then stopped by the test. `startDummy` then `stopDummy` sets `via: "bench-tool"`, which is the only thing `expect.stopDummy` accepts.

### Commands

`npm run check` after the fence fixes (vitest, tsc, script tests, `cargo fmt --check`, clippy `-D warnings`, `cargo test`):

- vitest: 1129 files passed, 2 skipped; 9233 tests passed, 13 skipped
- tsc: passed (the script tests started after it)
- script tests: 341 passed, 0 failed, 2 skipped
- Rust lib tests: 1669 passed, 0 failed, 2 ignored
- Rust mobile_link tests: 32 passed, 0 failed
- fmt and clippy passed (cargo test ran only after both)

The check log ends as the doc-tests start (`Doc-tests monocode_lib`, `Doc-tests monocode_mobile_link`) and prints no failure. No Rust file changed in these commits.

`node --test` on the fence, permission, fence-args, haiku, and realtest script tests: 50 passed, 0 failed.

### Not checked

The live benches (`hub:realtest`, `hub:realconv`) were not run, on purpose. A real scene is what shows an agent actually being refused `kill`, and being unable to read the real `agent-memory` file, including after a tester would have clicked Allow. The app snapshot is matched by bundle name, so a second instance of the same app still counts as present.

## Seatbelt under the fence

The lexical fence stays the first layer. On macOS the wrapper (`scripts/hub-realtest-claude.mjs`) starts every agent CLI through `sandbox-exec -f <REALTEST_STATE>/sandbox.sb`. A missing `sandbox-exec`, a real home that is not set, a folder list that is not a JSON array of strings, or a profile that does not load, refuses in one plain sentence and does not spawn the agent. `--version` is wrapped too. The haiku no-key refusal still happens before either spawn. A chat with no bench settings file is still refused before the sandbox check.

Outbound is not all of loopback. The profile denies `network-outbound` and `network*`, then allows one remote per named port: `(remote ip "localhost:<port>")`. This scheme only accepts `*` or `localhost` as the host. `localhost` is its name for every loopback address, so `127.0.0.1` and `::1` are covered by that one filter and are not written as their own lines. There is no `localhost:*` remote, no `network-inbound` allow, and no unix-domain socket allow. Bind is only `(local ip "localhost:*")`, so a client can take an ephemeral local port. A comment above each allow names the port and why.

The ports, and only these:

- The local model gateway the launcher uses. `REALTEST_GATEWAY`, when set, is that port and nothing is observed. Otherwise `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN +c 0`. The `+c 0` is required: the default command column truncates `cli-proxy-api`. Lines containing `cli-proxy-api` are kept. A `*` listen is treated as connect-to `127.0.0.1` and is not, by itself, the internet. A specific non-loopback listen is not added, and then no gateway port is added. The launcher's code and its config were not read.
- This dev copy's own control port, `MONOCODE_CONTROL_ENDPOINT`.
- This run's stub hub port, `REALTEST_HUB_PORT`, or else `MONOCODE_HUB_PORT`. A value of 18767 is dropped and is not replaced by the other variable.

Port 18767 cannot be named. The daily app's hub bridge and its control port are not among these, so they stay unreachable. Anything else is denied, loopback included.

While proving the call below, `cli-proxy-api` was already listening on `127.0.0.1:18317` and on no other address. The launcher did not start it. The completed call's only TCP remote was `127.0.0.1:52146 -> 127.0.0.1:18317`. The launcher does not need a direct internet connection from inside the sandbox. This is not the case that stops for an allow-list proxy.

Nothing under the real home is readable except the CLI's own install, config and credential paths. Each is a comment in the profile:

- the CLI this run starts
- `~/.monocode-hub-dev/claude-config`, the dev copies' shared Claude config, read only (writes stay closed)
- `~/.local/share/claude`, Claude Code's install directory
- `~/.local/bin/claude`, the program the DeepSeek and Grok launchers exec, and the one claude and haiku-test start
- for a CLI named `claude-deepseek` or `claude-grok` only: `~/.local/share/claude-gpt/proxy-key` (the gateway key, read once at start), `launcher.py`, `settings.json`, and `~/.local/bin/<that name>`. Not the `claude-gpt` directory, and not `config.yaml`. Haiku and claude do not get the key.

Every other path inside the real home is dropped, including the dev copy's data folder and a built app. The profile is built with `cli` set to the binary being started, or those launcher files are filtered out. Still dropped rather than written in: `agent-memory`, `.ssh`, `.claude`, `Projects`, `Worktrees`, and `Library/Application Support` when it is under the real home. A run root of `/`, the real home, or an ancestor of the real home is dropped. A `/Users/…` path that is neither under the real home nor under a run root is dropped. The temporary home being the real home, or sitting inside a closed tree, refuses the run.

With the home closed, `pwd.getpwuid` cannot see the user unless Open Directory's libinfo is reachable. The launcher then looks for a literal `~501/...` path, which bash does not expand. The profile allows three mach lookups and nothing else of that kind. This is not a file under the home. `system-socket` and `membership` are not in the profile.

```
(allow mach-lookup
    (global-name "com.apple.system.opendirectoryd.libinfo")
    (global-name "com.apple.system.opendirectoryd.libinfo_v2")
    (global-name "com.apple.system.DirectoryService.libinfo_v1"))
```

A wider set (notification center, coreservicesd, launchservicesd) was tried and is not needed. With only these three names, `getpwuid` returns the real home directory while that directory stays unreadable, and the DeepSeek call below completed.

`(deny default)`. No `(allow default)`. This macOS rejects `(deny process-exec (with no-sandbox))` (`no-sandbox modifier does not apply to deny action`, exit 65). Those denies are not in the profile, and the profile text does not contain that token. A child inherits the profile. Signals stay `(deny signal (target others))`, then self, children, and same-sandbox.

If the process cwd is under the real home, a shell dies on getcwd. `sandboxCwd` sends a missing cwd, or one inside `REALTEST_REAL_HOME`, to the temporary `HOME` (or the system temp dir when that home is the real one). A cwd outside the real home is kept. `launchReal`, `sandboxedCli` and `sandboxedCliSync` all use it. The grader still passes its evidence directory; when that directory is inside the real home the child starts in the temporary home instead. The parent writes `grade.json`.

The tester and the grader use the same profile. The default CLI spawn in `scripts/realconv/llm.mjs` goes through `sandboxedCli`. An injected spawn is left alone. The default `fetch` goes through `modelUrlAllowed`, with gateway observation off, so an HTTP model call is refused unless its URL is a loopback port this run already named (`the model call is refused: that address is not a loopback port this run named`). An injected fetch is not guarded. The grader uses `sandboxedCliSync`. A grader named `--agents claude` that talks to Anthropic is refused. The internet was not opened for it.

One real spawn of the DeepSeek launcher, under the profile, with `HOME` and the cwd a temporary directory, and only the three mach lookups above. The prompt was `Reply with the one word pong.` The gateway key's contents were not printed.

`PROOF status=0 timeout=false pong=true remotes=127.0.0.1:52146->127.0.0.1:18317 off=none stderrBytes=0`

No other remote. No 18767. That spawn was a proof, then removed. It is not part of `npm test`.

### cd

A relative path after `cd <dir> &&` or `cd <dir>;` (and a newline, which is the same as `;`) resolves against that directory. `FOO=1 cd`, `command cd`, `command -p cd`, `builtin cd` and `env cd` count. `cd` with no destination is the temporary home. `cd -`, or a destination that does not resolve, denies the rest of the command. `||`, `|` and `&` do not change the directory. `cd $(…)` is still the old hole; the seatbelt is what closes it.

### Done when

**The generated profile contains each rule.** Met. `scripts/bench-sandbox.test.mjs`: "the profile closes the real home, signals, writes and the outbound network" (no `(allow default)`, no outbound allow when no port was named, no `:18767`, no `no-sandbox`, the proxy-key line present for deepseek, the `claude-gpt` directory absent, the three mach names present, `system-socket` and `membership` absent). "outbound is only the named loopback ports, and the daily hub port is never one of them". "the named ports come from the gateway, the control endpoint and the stub hub, never 18767". "a read under a closed tree is dropped, and haiku does not get the gateway key".

**A child under the profile cannot read a fake real home, write outside, signal a sibling, or connect off the named ports, and can use the named gateway port.** Met on this Mac. Same file: "a child under the profile cannot read the real home, write outside, signal a sibling, or reach a loopback port that was not named". The named port accepts a connection. A listener the test starts on another loopback port does not. `203.0.113.1:9` is not permitted, and the failure is not a timeout. The test skips off macOS. A missing `sandbox-exec` fails it.

**The bench refuses when sandbox-exec is missing or the profile does not load.** Met. "a missing sandbox or a profile that does not load is a refusal", and the wrapper test: a missing path and a stub that exits 1, both on `agentCommand` and through the wrapper. The fake CLI's marker stays absent.

**The tester and the grader use the same rules.** Met. "a grader or tester CLI is not started when the sandbox is missing". "a sandboxed process does not start inside the real home". "the grader's working directory is outside the real home". "the profile can ask the system who this user is without opening the home" (darwin): `getpwuid` prints the real home directory while that directory is closed. An HTTP model call to a port this run did not name is refused before any request (`scripts/hub-realconv.test.mjs`).

**A relative path after cd resolves against that directory.** Met. `scripts/bench-guard.test.mjs`, including the hook exiting 2. Unchanged by the port tighten.

### Commands

`npm run check` (`vitest run && tsc --noEmit`, then the script tests, then `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test`):

- vitest: 1129 files passed, 2 skipped; 9233 tests passed, 13 skipped
- tsc passed: the script tests started only after `vitest run && tsc --noEmit`
- script tests: 354 passed, 0 failed, 2 skipped
- fmt and clippy passed: cargo test started only after both
- in that log the lib tests printed `1669 passed; 0 failed; 2 ignored`. The saved log ends as `Doc-tests monocode_lib` and `Doc-tests monocode_mobile_link` start, and does not include those suites' result lines

`cargo test --offline` on the same tree afterwards: 1701 passed, 2 ignored, 5 suites, 31.86s.

`node --test scripts/bench-sandbox.test.mjs` before that check: 11 passed, 0 failed.

### Not checked

The live benches (`hub:realtest`, `hub:realconv`) were not run.

The dev Claude config is read-only. Claude writes transcripts there when the run has no other account folder. Those writes will fail. Whether a chat still starts is a bench run, which was not done.

`proxy-key` is one file. Once the DeepSeek or Grok launcher can read it, every child of that process can read that same file. The rest of `claude-gpt` stays closed. Outbound network is the named ports only, so the key cannot be sent off the machine. It can be copied into the temp project.

A sandboxed launcher cannot start the gateway. The gateway has to be listening already. It was, on `127.0.0.1:18317`.

`cd $(echo /Users/ash)` is still not tracked by the fence. The seatbelt is the layer that closes it.

Windows was not checked. The spawn tests skip off macOS.


