# WP-134b: More agents, first slice

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | WP-134 | yes |

This package builds the recommended first slice from WP-134. The design stays in `WP-134-acp-registry.md`. This file names what is built and what is left out.

## Slice

More agents, add a local command, and one generic ACP session on the desktop TypeScript path. That is the path `App.tsx` already uses to send a turn.

A setting named More agents sits on the providers page, below Agent CLIs. It is off by default. With it off, a chat that has no registry agent id takes the same CLI path as before. Nothing in this slice is launched, listed, or offered until the person switches it on.

The person names an executable that is already installed. Arguments are a list of literal strings. Hivra does not expand them and does not download a binary.

Each entry has an id (a stable slug, not empty, not one of the eleven), a name, a command, args, and protocol `acp-v1` only. An entry carries no environment of its own: a child gets only the allow-listed names in `src-tauri/src/more_agents.rs` (`ALLOWED_ENV`), never the app's keys, tokens or control endpoint. Unknown fields are ignored. A bad entry is shown as unusable and skipped. The rest of the list still loads. A write carries the revision that window last read, so one window cannot wipe an agent another window just added. Removing an entry drops the launch link only. It does not delete the agent's files, its sign-in, or the chats. The chat still remembers which agent it belonged to, so a reload does not open it as one of the eleven.

A chat is one or the other. `harness` stays one of the eleven. The registry agent id lives in its own field. `asHarness` and `Kind::from_id` never see that id. An unknown registry id does not become Cursor or Codex.

The process is started by `harness_spawn` with a `more_agent` id and no command from the webview (`src-tauri/src/harness.rs`). Rust reads the entry from the saved list and checks the approval (`approved_spawn` in `src-tauri/src/more_agents.rs`). The child registers with the same host as the eleven, so writing to it and stopping it use the existing calls. It never resolves one of the eleven, opens no port, and does not hand the child the app's control token or a key. A command is found as an absolute path or as a bare name on absolute folders of the search path; a relative or empty PATH folder is never searched. The eleven names, shells (`sh`, `bash`, `cmd`, `powershell`, `env` and the like) and inline-program flags (`-c`, `-e`, `--eval`, `-p`) are refused. `Kind` and `acp.rs` are not touched.

Usable means the command starts, `initialize` succeeds at protocol version 1, and a turn can be sent with `session/new` (or `session/load` when continuing) and `session/prompt`. `canSteer` stays false. A follow-up waits until the turn finishes. Approvals show `session/request_permission` and do not copy a per-CLI shortcut. A tool with no locations and no preview still shows its title plus "No preview from this agent." Cancel sends `session/cancel` and says stop was sent, not that the agent confirmed it.

An approval is for one exact thing: the command and arguments the person saw, the absolute file they resolve to, and that file's SHA-256. The window sends back the fingerprint it displayed, and the app refuses an allow that does not match. A spawn, and each turn in a chat that is already running, is refused when the file changed on disk. Withdrawing or removing an entry stops its running agent. A chat's turns, stops and answers go to its entry from the moment the chat loads, never to the harness it was saved with.

Anything that cannot run shows one of the sentences in the WP-134 table and does nothing. A missing command stays in the list. A timeout or a process that does not answer is "Not answering", with Retry. It is not a deleted entry and not a success.

## Out of scope

- A twelfth CLI. No change to `HarnessId`, `HARNESSES`, `Kind`, `acp.rs`, or a `providers/<id>/` package.
- Copilot's flavor: lost-session errors, subagent routing, and the sentence "This chat's session is gone. Start it again."
- Downloads, the public ACP registry, and an installer. (The app checks each file's SHA-256 against the approval; it does not fetch one.)
- A manifest file the person points at. The list is the settings document. A file import is a later slice.
- The native shell, the phone app, crews, a first-mate row, a default model record, a subscription meter, and an account waterfall.
- Title, commit, or pull request text, rewind, compaction, attachments, and steer.
- Cursor's model-picker flag and Grok's extra session flags.
- GitHub Copilot models inside Pi and omp. Those stay as they are.
- The plugin registry. An ACP agent does not belong in `plugin.json`.

`Kind` stays the eleven. This slice does not teach the native shell to read the list. It also does not call `from_id` with a registry id.

## Done when

- [x] More agents is a setting, off by default, and with it off a normal chat still uses the CLI path.
- [x] A local command can be added, kept, and removed. A bad entry does not wipe the list. A stale write does not wipe a newer one.
- [ ] One generic ACP session can send a turn on the desktop path, and every failure in the WP-134 table shows its sentence and is not a success. Unit tests and a real child process test pass. It has not been run in a live app window, so this stays open.
- [x] An allow, a spawn and a running chat's next turn all check the approval the person saw, and a changed file is refused (`more_agents.rs` tests, `moreAgentAdapter.test.ts`).
- [x] An unknown registry id is not passed to `asHarness` or `Kind::from_id`.
