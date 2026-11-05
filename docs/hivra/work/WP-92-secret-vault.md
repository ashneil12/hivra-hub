# WP-92: Agents ask for a secret and use it without ever seeing it

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| I | L | none (14 when merged) | no |

## Goal

An agent that needs a key asks for it with a tool call. A form card appears in the chat, the person pastes the
value once, and it goes straight into the Mac's keychain. From then on "use my Stripe key" just works: the agent
asks for it by name, the app hands it to one named command for one run, and the agent only ever sees the command's
output with the value taken out. The agent never sees the value itself, and the value never lands in a chat, a
transcript, a log, the database, an export or a file.

The one sentence the package must keep true: **a secret's value exists in exactly two places, the person's
keychain and the environment of one command the person approved, and nowhere else.**

## Why

Ash, 5 Nov: "any agent that needs a secret just asks for it, with a tool call. The person gets a simple form card
in the chat, pastes the value, and it's stored securely. Later 'use my Stripe API key to do this' just works,
because the agent knows where to get it. Today I have to go into project settings and add it by hand. Other tools
(Grok Bot) just show a form."

Today the only way to hand a key over is the worst one: the person types it into a chat message ("Needs Ash
(provide)"), and that message is written into `blocks_json`, into Claude Code's transcript JSONL, into backups and
into exports. The export scrubber catches known key shapes, but only known ones, and by then the value has already
travelled. The credential guard (`src/integrations/harness/core/credentialGuard.ts`) correctly forbids agents from
reading the keychain or running `op run`, so there is no legitimate route today. This package adds one, and only
one.

How comparable tools do it, from general knowledge (nothing copied, so no NOTICE or credits line):

- **1Password's `op run`** resolves `op://Vault/Item/field` references into environment variables for the child
  process only, so the parent shell and the process list never hold the value; it masks known secret values in the
  child's output by default; and config files can hold the reference instead of the value, so a rotation reaches
  every consumer without editing anything. **Borrow:** the env is for one child, never the app; masking the output
  is a required second line, not a nicety; reference a secret by name, never copy its value.
- **Doppler's `doppler run -- command`** fetches a config's secrets when the process starts and injects them into
  that process, so the value lives in one place, a change applies to the next run, and the service can say who read
  what. **Borrow:** project and global scope, central rotation, and an activity record of every use.
- **macOS Keychain ACLs.** Each item carries an access control list of trusted applications plus a designated
  requirement derived from the app's code signature. A program that isn't trusted gets the system prompt, and
  "Always Allow" adds it to the ACL. Under the old ad-hoc signature the requirement was a bare `cdhash` that changed
  on every build, so the prompt came back each time; the Hub now pins a stable identity (CLAUDE.md, "Signing"), so
  "Always Allow" sticks. **Borrow:** one item per secret holding the app's trust; the OS prompt is a second gate a
  script or another app cannot pass silently. On Windows the same role is played by Credential Manager per-user
  items, and on Linux by the Secret Service — both already reachable through the `keyring` crate that
  `src-tauri/src/platform/secrets.rs` names. There is no file fallback: if the OS store is missing, the page says so
  in plain words and the vault is unavailable.

## Read first

- `docs/PORTABLE.md` and the export rules in CLAUDE.md ("Export and import"): secrets never go in an export.
- `src/features/portable/model/secretPatterns.json` and `src-tauri/src/portable.rs`: the one shared pattern list and
  the final scan that refuses an export. The vault's output scrubber reuses this list at the end.
- `src-tauri/src/hub_keychain.rs`: `PREFIX`, `DEV_PREFIX`, `check_service` (ASCII `[A-Za-z0-9_.:-]`, at most 120
  characters), `scoped_service`, and the rule that a dev copy never forms a daily name. Every keychain call in this
  package goes through it.
- `src-tauri/src/platform/secrets.rs`: the backend name and the failure sentences per OS.
- `src-tauri/src/connectors/secrets.rs`, `signing.rs`, `launch.rs`: the existing pattern for a secret handed to a
  child process — a redacted `Login`, a HMAC-SHA256 signature over the arguments with `monocode-hub:connector:launch-key`,
  args are literals, env values are filled from the login, everything printed goes through `redact`. This package
  copies that shape for a single run.
- `src-tauri/src/backups/mod.rs` (`spawn_helper`): `.env_clear()` plus an explicit `allow_env` list. That is the
  child environment model here.
- `src-tauri/src/harness.rs`: `login_shell_path()` and `cached_gui_search_path()` — a Finder launch has a short
  PATH, so the child's PATH must be the login shell's.
- `src-tauri/src/mcp_server.rs` and `src/features/agent-app/model/agentApp.ts`, `agentAppTasks.ts`: how a tool is
  declared, how `arguments()` rejects unknown fields, how `tasks.ask` returns immediately and how the app answers
  over the control port.
- `src-tauri/src/decisions.rs`, `src/features/firstmate/model/steering.ts`,
  `src/features/hub/model/localHub/decisions.ts`, `src/features/hub/model/chatQuestions.ts`: the decision/Needs
  pattern this card follows, including `keyAsk` and `provideNeeded`.
- `src-tauri/src/instance.rs`: `policy().daily_keychain`, `in_isolated_home`, and the rule that a dev copy and a
  bench get their own names.
- `src-tauri/src/hub_plugin.rs` and `src-tauri/build.rs`: a new Tauri command must be listed in both.
- `src/features/settings/model/settings.ts` and `src/features/settings/ui/SettingsView.tsx`: where a Settings page
  is added (one section entry, one small page block with a `WP-92:` comment).
- `src/integrations/harness/core/credentialGuard.ts`: the deny rules that stay, and the `SECRET_ACTION_*` checks.
- WP-14 (decisions), WP-78 (activity log), WP-70 (task card), WP-75 (backups).

## Build

1. **The vault, in Rust** (new module `src-tauri/src/secrets/`). One keychain item per secret, service
   `monocode-hub:secret:<scope>:<name>`, account `value`, written and read only through
   `hub_keychain::store/read/delete` so the dev prefix and the service guard apply. `<scope>` is `global` or
   `project.<id>`; if the assembled service would pass the 120-character guard, the project id is replaced with a
   SHA-256 prefix. `name` is a normalized slug: lower case, spaces and underscores to `-`, ASCII letters, digits and
   `-` only, 1–64 characters, no leading or trailing `-`. The display label may be any unicode text and is kept
   separately. Values are 8–8192 characters after trimming trailing CR/LF only (a PEM keeps its internal newlines);
   empty, whitespace-only, longer, or non-text values are refused with a plain sentence. `last4` is the last four
   characters, and only when the value has at least 12 characters; shorter values get none. In Rust the value is a
   `Zeroizing<String>` with a `Debug` that prints the name, never the bytes.

2. **Metadata in the app's own database, never the value.** Three tables beside the existing decisions table:
   - `secrets` — `(scope, name)` primary key, `label`, `last4`, `created_at`, `updated_at`, `version`;
   - `secret_grants` — `(scope, name, mono_id, executable)` primary key, `mode` (`once` or `always`), `created_at`;
   - `secret_requests` — `id`, `chat`, `mono`, `project`, `scope`, `name`, `purpose`, `state`
     (`open`, `saving`, `filled`, `declined`, `expired`), `answer_token`, `created_at`, `updated_at`.

   Every write is compare-and-swap on `version`; two windows answering the same request race through the
   `open → saving` transition with a token, and the loser gets "already saved" in plain words. A request left in
   `saving` for more than five minutes (a crash between the keychain write and the row update) goes back to `open`
   at startup. Nothing in these tables can reconstruct a value.

3. **The agent's three tools** in `monocode mcp`:
   - `request_secret {name, purpose, scope?}` — creates an `open` request and returns at once with
     `{requestId, state: "waiting", name, scope}`, like `ask_person`. If a secret of that name and scope already
     exists, it returns the handle instead of showing a card. If the person hasn't answered, the turn ends and the
     chat says one line: waiting for a key. A worker is refused with the same plain reason workers get for
     `ask_person`: its first mate asks.
   - `list_secrets {}` — handles only: name, label, scope, when it was added, last 4 (or none), which executables
     are approved, and when it was last used. No tool anywhere returns a value.
   - `run_with_secret {name, env, command, cwd?, timeoutSeconds?}` — `env` matches `[A-Z_][A-Z0-9_]{0,63}` and may
     not be a name already in the child's allow-list; `command` is a non-empty array of strings (argv, never a shell
     line); `cwd` must resolve inside the current project; `timeoutSeconds` defaults to 120 and caps at 600. The
     result is `{exitCode, stdout, stderr, timedOut, truncated}` after scrubbing.

   Name resolution: the chat's project scope first, then global. If both exist the project's wins and the result
   says which it used. If neither does, the tool returns `state: "missing"` and the model calls `request_secret`.
   "Use my Stripe key" therefore means: try `run_with_secret` with the obvious slug; if it is missing, ask for it
   with that slug and a purpose.

4. **The form card, and how the value travels.** A `SecretRequestCard` beside the composer (and in Inbox under
   Needs, from the same row) shows the normalized name, the label, the purpose in the Mono's own words, the scope,
   and which Mono asked. The input is an uncontrolled password field with a reveal toggle; the value lives in the
   DOM until Save, is read once, and is passed straight to the `secrets_save` Tauri command. `secrets_save` writes
   the keychain first, then marks the request filled with its token, and returns only the handle. It is never put in
   React state, props, context, `localStorage`, IndexedDB, the transcript, `blocks_json`, a log line or an error
   message; a failed save clears the field and shows one sentence, and the person tries again on a fresh card. Save,
   Not now and Cancel all close the card; Not now marks it declined and the Mono gets a plain note. A filled request
   resumes the Mono's turn with a note naming the handle, exactly as an answered decision does.

5. **Using it: a signed grant for one run.** `run_with_secret` calls the app over the control port
   (`secrets.run`). The app checks, in this order: the caller's chat identity; that a secret resolves in scope; that
   this Mono has a live grant for this executable, or asks the person first (step 7); that the executable is on the
   secret's approved list; that `cwd` is inside the project; that `version` still matches. It then returns a grant:
   a base64 JSON of `{scope, name, version, env, command, cwd, nonce, expiresAt}`, signed with HMAC-SHA256 under
   `monocode-hub:secret:grant-key` (created on first use, dev-scoped like every other key).

   The MCP server runs its own binary as `monocode secret-run --grant <base64>`. That process verifies the
   signature, refuses an expired grant (60 seconds), refuses a nonce it has already seen (a small file under the
   copy's data folder), re-reads the secret (refusing if the version changed or the item is gone), checks no argv
   element contains the value, then spawns the command with:

   - `env_clear()` and an allow-list only: the login shell's PATH (`harness::login_shell_path()`), HOME or
     USERPROFILE, TMPDIR/TEMP/TMP, LANG/LC_ALL, TERM/SHELL, and on Windows SystemRoot, ComSpec, PATHEXT, HOMEDRIVE
     and HOMEPATH — plus the one secret. No app token, no `MONOCODE_*`, no model keys, no other secret;
   - its own process group, killed as a group on timeout or on the app quitting;
   - stdout and stderr captured, never inherited.

   It writes one JSON object to stdout: the scrubbed streams, the exit code, `timedOut`, `truncated`, and nothing
   else. The MCP server passes that back as the tool result. A timeout is reported as `timedOut: true` with the
   output so far, not as a failure; a keychain refusal (the person clicked Deny on the system prompt) is "not now,
   try again", not "wrong secret". The app writes the run to the activity log (WP-78) with the name, scope, Mono,
   executable, exit code and duration — never the grant, never the value.

6. **The scrub rule, exactly.** Before any command output reaches the model, every needle below is replaced with
   `[secret removed]`, longest needle first, using plain string search, never a regex built from the value:
   1. the raw value; 2. the value with trailing CR/LF trimmed; 3. its JSON-escaped form (serde_json's escaping);
   4. percent-encoded with upper-case hex; 5. percent-encoded with lower-case hex; 6. form-encoded (`+` for space);
   7. base64 standard with padding; 8. base64 standard without; 9. base64 URL-safe with padding; 10. URL-safe
   without; 11. hex lower case; 12. hex upper case; 13. its Unicode NFC and NFD forms (a Mac terminal prints NFD);
   14. for a multi-line value, each line of 8 or more characters on its own (a PEM printed line by line).
   Afterwards the shared `secretPatterns.json` scrubber runs over the result. Each stream is capped at 256 KiB with
   `[output cut]` and `truncated: true`. Finally the result is scanned again for every needle; if any survives, the
   stream is replaced whole with "The output looked like it held the secret, so it was not returned." Values under
   8 characters are refused at save precisely so every needle is long enough to hide without mangling text.

   What is still hard, said plainly on the page and in this package: a command can print the value under encoding
   not on that list (gzip, base32, double base64, ROT13), one character at a time, or split across lines; it can
   write the value to a file, the clipboard or the network instead of stdout; a child it leaves behind keeps the
   environment after the run. The scrubber is a second line of defence, not the first. The first is that only an
   executable the person approved ever gets the value at all.

7. **First use, and approvals.** The first time a Mono runs a given secret with a given executable, a small card
   asks: "Let <Mono> run `stripe` with Stripe API key?" with Once, Always and No. Once writes a `once` grant that is
   consumed by the next spawn; Always writes an `always` grant. No writes nothing and returns "Ash said no" to the
   tool. An unanswered card behaves like an unanswered decision: the run returns "waiting for Ash's OK" and the
   turn ends. The default for a new secret is therefore ask each time, and the page says each secret's current mode.
   The Mono that asked for the secret does not get a free pass: the approval is about what runs with it, not about
   who typed it.

8. **Resolution, rename, rotate, delete.** "Use my Stripe API key" is a slug lookup, so the card shows the slug it
   will store (`stripe-api-key`) and the person can edit the label only. Rename changes the label; the slug stays, so
   every agent and grant that names it keeps working. Replace value writes a new value to the same item, bumps
   `version`, and leaves grants in place; a run whose grant names the old version is refused with "that secret
   changed, ask again". Delete is Revoke: it removes the keychain item, the row and every grant, after a confirm
   that names what will stop working. Re-adding the same slug starts fresh with no grants.

9. **The Secrets page** in Settings: section id `secrets`, label "Secrets", description "The keys your agents can
   use, kept in your Mac's keychain. Never in chats, files or backups." It lists every secret with its label, scope,
   when it was added, its last four characters or none, the Monos approved to use it, and when it was last used;
   pending requests with the same form card; a manual "Add a secret" for the person; and per row Rename, Replace
   value, Approvals and Delete. The page never calls a command that returns a value, and a test holds that: the
   invoke spy sees no value field on any call it makes. Dev copies show their own list, with a line saying so.

10. **Connectors use the vault.** A connector's login field may hold a vault reference instead of a copy:
    `{"secret": "stripe-api-key"}` in its saved config. `connectors::prepare` resolves it through the same scope and
    the same keychain call, so rotating the value reaches every connector that references it. A button on the
    connector's settings moves an already-saved login into the vault (one click, one confirm) but nothing migrates
    silently. The connector still gets its launcher signature and its redaction; this only changes where its login
    comes from.

11. **Dev copies and benches never see the daily secrets.** Every service name comes from
    `hub_keychain::scoped_service`, so a dev copy only ever forms `monocode-hub-dev:secret:…`, and the dev keychain
    holds different items. Under an isolated HOME (a bench, `verify_live`), the vault uses an in-memory store that
    is seeded only by a test's own value and never touches the real keychain; tests can inject one through a
    dev-copy-only environment variable, like `MONOCODE_PR_WATCH_GH`. `npm run hub:seed-dev` clears the vault's
    metadata, grants and requests in the copy, and cannot copy values because it never reads the keychain. A test
    asserts a dev copy cannot name a daily vault service, and that a daily grant does not verify in a dev copy.

12. **Exports carry an index, not a vault.** The export writes `secrets/index.json` with `name`, `scope`, `label`,
    `last4` and `createdAt` and nothing else; the shared scrubber still runs and the final scan still refuses the
    export on any pattern hit. Import creates the rows in a "needs its value" state with no grants; the Secrets page
    lists them first, each with "Add the value", and nothing is usable until the person types it. `docs/PORTABLE.md`
    gets two sentences saying exactly this.

13. **The instruction and the old paste path.** The MCP instructions gain one line: "Need a key or token? Call
    `request_secret` with a name and a purpose. Never ask the person to paste it into chat." When a finished turn's
    "Needs Ash (provide)" names a key, the app now offers the secret form instead of a text box that would become a
    chat message (`chatQuestions.ts`, `provideNeeded`). The deny rules in `credentialGuard.ts` stay as they are;
    `monocode secret-run` is added to the Bash deny rules so a worker cannot invoke the launcher directly, and the
    grant's signature is the guard that actually matters.

14. **Plain words everywhere.** The page, the cards and every failure sentence use the words key, secret, command
    and nothing else: "Saved in your Mac's keychain", "Not now", "That key is shorter than 8 characters", "Your
    Mac's keychain is locked. Unlock it and try again", "The command timed out after 2 minutes. Its output so far is
    below." No value, no partial value but the last four characters, never in an error, a title or a log line.

15. **Not this package.** No browser autofill or password-manager import, no syncing, no sharing between people, no
    per-secret expiry reminders. Say so in the PR rather than half-building them.

## Done when

- [ ] Rust tests, with a memory store and a fixture command:
  - the service name rules: slug normalization, the 120-character guard, spaces, unicode labels, `..`, case-only
    duplicates, empty and missing names, a project id that has to be shortened;
  - daily and dev names never cross, and an isolated HOME uses the memory store;
  - value bounds: 7 characters refused, 8 accepted, 8192 accepted, 8193 refused, trailing CRLF trimmed, internal
    newlines kept, empty and whitespace refused; `last4` absent below 12 characters, last four characters above;
  - save is compare-and-swap: a second answer to the same request is refused, a stale `saving` row reopens, a crash
    between the keychain write and the row update leaves no usable half-state;
  - rotate bumps the version and refuses an old-version grant; delete during a run reports "that secret was
    deleted"; a keychain denial is "try again", not "wrong secret"; a locked keychain says so;
  - the scrub rule: raw, trimmed, JSON, percent both cases, form, all four base64 forms, hex both cases, NFC and
    NFD, a PEM line, longest-first with one value inside another, a value containing regex metacharacters, a value
    split across lines (not caught — asserted as a known limit), the final rescan dropping a stream, the 256 KiB cap
    and the truncation marker;
  - the child environment holds the allow-list, the one secret, and none of `MONOCODE_*`, the app token or a model
    key; argv never carries the value; a shell wrapper (`sh -c`, `cmd /c`, `powershell -Command`, `env`) is refused;
  - timeout kills the whole process group and reports `timedOut`; a non-zero exit returns its output and code; a
    command with spaces and unicode in its path and cwd works; CRLF and invalid UTF-8 output survive lossily;
  - grants: signature verified, tampered name/env/command/cwd refused, expired refused, replayed nonce refused, and
    a daily grant refused in a dev copy;
  - a worker's `request_secret` is refused with the first-mate reason; `list_secrets` returns no value field;
  - two windows answering one request: one saves, the other is told it was already saved.
- [ ] Webview tests: the card sends the value once and clears it; a save failure shows one sentence and no value;
    the page's invoke calls carry no value; first use asks once, "Always" stops the asking, "Once" asks again; a
    project secret wins over a global one and an ambiguous name is refused; rename keeps grants; delete removes
    them; the old "Needs Ash (provide)" path now opens the card.
- [ ] Browser specs on Chromium and WebKit: the Secrets page (add, list with last 4, rename, replace, delete with
    confirm) and the chat card (paste, Save, and the value is absent from the page's text, the DOM afterwards and
    `localStorage`), with a screenshot in `docs/hivra/work/shots/`.
- [ ] Export: a planted key value never appears in the archive, `secrets/index.json` holds only the index, the
    final scan refuses on a planted pattern, and import lands in "needs its value" with no grants.
- [ ] `npm run hub:seed-dev` leaves a slot with no vault metadata, grants or requests.
- [ ] Dev-copy check, in the dev slot's keychain namespace only, with a dummy value: a fixture command prints the
    value and the model would see `[secret removed]`; no `monocode-hub:secret:*` daily item is created.
- [ ] `npm run check` passes (web, script and Rust), plus `cargo clippy --target x86_64-pc-windows-gnu
      --all-targets -- -D warnings` where the Windows target is installed.
- [ ] Mac-only checks for Ash: the keychain prompt appears once for the app, "Always Allow" sticks across a
      rebuild with the pinned identity, and the granted run prints `[secret removed]` where the value would be.
