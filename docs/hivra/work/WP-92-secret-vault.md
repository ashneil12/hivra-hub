# WP-92: Agents ask for a secret and use it without ever seeing it

Ash, 5 Nov 16:48: build this after the final ship. Docs only until then.

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| I | L | none (14 when merged) | no |

## Goal

An agent that needs a key asks for it with a tool call. A form card appears in the chat, the person pastes the
value once, and it goes straight into the Mac's keychain. From then on "use my Stripe key" just works: the agent
asks for it by name, and the app puts it in the one place the person approved — the environment of one named
command (or one worker), or a gitignored `.env` in one worktree — and the agent only ever sees the command's
output with the value taken out. The agent never sees the value itself, and the value never lands in a chat, a
transcript, a log, the database, an export, or any file the person did not pick.

The one sentence the package must keep true: **a secret's value exists in the person's keychain and in at most
one place they chose with a tap — the environment of one approved command or worker, or a gitignored `.env` in
one worktree — and nowhere else.**

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
- `src/integrations/harness/core/credentialGuard.ts`: the deny rules that stay, and the `SECRET_ACTION_*` checks.
- WP-14 (decisions), WP-78 (activity log), WP-70 (task card), WP-75 (backups).

Everything else this package builds on is listed with its file in **Reuses**, below. Read those files there; do not
write a second copy of any of them.

## Reuses

| Existing piece | What is already there | What WP-92 builds on it |
| --- | --- | --- |
| `src-tauri/src/hub_keychain.rs` | `PREFIX`, `DEV_PREFIX`, `check_service` (the app's own services only, ASCII `[A-Za-z0-9_.:-]`, at most 120 characters), `scoped_service` (a dev copy only ever forms `monocode-hub-dev:*`), `store`/`exists`/`read`/`delete`, and `entry`'s account guard and `policy().daily_keychain` rule | Every vault read, write and delete. `monocode-hub:secret:<scope>:<name>` passes `check_service` by construction, and a dev copy can only ever form `monocode-hub-dev:secret:<scope>:<name>`. No new Keychain code is written. |
| `src-tauri/src/platform/secrets.rs` | `backend_name()` per OS, and the failure sentences `unreachable`, `not_saved`, `not_checked`, `not_read`, `not_removed` | The vault's failure words. A sentence it needs that isn't there ("Your Mac's keychain is locked…") is added here, not written inline. |
| `src-tauri/src/instance.rs` | `policy().daily_keychain`, `in_isolated_home`, `Kind::Daily` / `Kind::Dev` | Daily versus dev naming, and the in-memory vault a bench under an isolated HOME gets. |
| `src-tauri/src/connectors/secrets.rs` | `Login` with a `Debug` that lists field names only, `secrets()`, `redact()` (longest value first, `•••`), and the `SecretStore` trait with a `Keychain` and an in-memory `Memory` | The shape of the vault: a value type whose `Debug` prints the name and never the bytes, a store trait with a keychain impl and a memory impl for tests, and the longest-first rule. The connectors' `redact` is left as it is. |
| `src-tauri/src/connectors/signing.rs` | `hmac_sha256`, `sign`, `verify` (constant-time compare), `key()` read from the Keychain, a per-install key created on first use, never leaving Rust | The one-run grant: signed with `sign`/`verify` under its own item, created on first use, never handed to the webview. |
| `src-tauri/src/connectors/launch.rs` | `monocode connector-run`: the app's own binary, signed arguments, refuses an unsigned call, the login in this process's memory only, a cleared environment for local servers, every printed line through `redact` | `monocode secret-run --grant-stdin` is this pattern for one command: same binary, same signed payload (read from stdin, so it is never in the process list), same cleared environment, same redaction. |
| `src-tauri/src/backups/mod.rs` | `spawn_helper` and `allow_env()`: `.env_clear()` plus an explicit allow-list | The child environment model for `secret-run` and for a worker that is given a secret. |
| `src-tauri/src/harness.rs` | `login_shell_path()`, `cached_gui_search_path()` | The child's PATH when the app was started from Finder. |
| `src/features/portable/model/secretPatterns.json` | One pattern list (18 shapes, a secret-key name list, the `[secret removed]` marker) read by the webview and by Rust through `include_str!` | The vault runs this scrubber after its own needle scrub, and the composer, memory and export checks keep using it. One list; no second copy. |
| `src/features/portable/model/secrets.ts` | `redactText`, `redactValue`, `hasSecretText`, `findSecrets`, `isSecretKey` | The net in the composer for a pasted key, and the memory and export gates. Nothing new is written for shaped keys. |
| `src-tauri/src/portable.rs` | `scrubber()` (`Scrubber::redact_text`, `redact_value`, `findings`, `has_secret`), the final scan in `export()` ("still holds something that looks like a secret"), and the same scan on `history_bundle()` | The export: `secrets/index.json` plus one exact-value pass before the existing final scan. The final scan is unchanged. |
| `src-tauri/src/memory_review.rs`, `src/features/memory/model/doc.ts` | `mentions_secret()` and `hasSecretText`: a note that holds a secret-shaped string is refused, the previous file is left as it was, and the save is compare-and-swap | WP-92 adds an exact-value check to the same gate. The refusal, the CAS and the "leave the old file" behaviour already exist. |
| `src-tauri/src/fs.rs` | `canonical`, `git_ignored_names` (through `git check-ignore --stdin -z`; its caller falls back to a name-only `.gitignore` read outside a repo), `path_to_js` | The worktree `.env` write: prove the target is inside the worktree root and that git ignores it before a line is written. `git_ignored_names` becomes `pub(crate)`. |
| `src-tauri/src/decisions.rs`, `src/features/firstmate/model/steering.ts`, `src/features/hub/model/chatQuestions.ts` | The decision row, the card in chat and in Inbox under Needs, the resume note, `keyAsk`, `provideNeeded` | The request row, the card, the resume, and the "Needs a key from you" path. `provideNeeded` opens the secret card instead of a text box. |
| `src-tauri/src/activity.rs` | The activity log (WP-78) | One record per run: name, scope, Mono, executable, exit code, duration. |
| `src-tauri/src/mcp_server.rs`, `src/features/agent-app/model/agentApp.ts`, `agentAppTasks.ts` | How a tool is declared, how `arguments()` rejects unknown fields, how `ask_person` returns a request id at once and the app answers over the control port | `secrets_request` → `secrets.request` and `secrets_run` → `secrets.run`, the same way. |
| `src-tauri/src/hub_plugin.rs`, `src-tauri/build.rs` | Where a Tauri command is registered | The vault's commands, listed in both. |

## Build

1. **The vault, in Rust** (new module `src-tauri/src/secrets/`). One keychain item per secret: service
   `monocode-hub:secret:<scope>:<name>`, account `value`, written and read only through
   `hub_keychain::store/read/delete`, so the service guard and the dev prefix apply. A daily copy's Stripe key is
   `monocode-hub:secret:global:stripe-api-key`; the same item in a dev copy is
   `monocode-hub-dev:secret:global:stripe-api-key`, and a dev copy can never form the daily name. `<scope>` is
   `global` or `project.<id>`; if the assembled service would fail the 120-character guard, the project id is
   replaced with a SHA-256 prefix and the row keeps the readable id. `name` is a normalized slug: lower case,
   spaces and underscores to `-`, ASCII letters, digits and `-` only, 1–64 characters, no leading or trailing `-`.
   The display label may be any unicode text and is kept separately. Values are 8–8192 characters after trimming
   trailing CR/LF only (a PEM keeps its internal newlines); empty, whitespace-only, longer, or non-text values are
   refused with a plain sentence. `last4` is the last four characters, and only when the value has at least 12
   characters; shorter values get none. In Rust the value is a `Zeroizing<String>` with a `Debug` that prints the
   name, never the bytes.

2. **Metadata in the app's own database, never the value.** Four tables beside the existing decisions table:
   - `secrets` — `(scope, name)` primary key, `label`, `last4`, `created_at`, `updated_at`, `last_used_at`,
     `version`;
   - `secret_grants` — `(scope, name, subject_kind, subject_id, executable)` primary key, `mode` (`once` or
     `always`), `created_at`; `subject_kind` is `mono` or `project`, so a grant is per Mono or per project;
   - `secret_requests` — `id`, `chat`, `mono`, `project`, `scope`, `name`, `why`, `state`
     (`open`, `saving`, `filled`, `declined`, `expired`), `answer_token`, `created_at`, `updated_at`;
   - `secret_env_writes` — `(scope, name, worktree)` primary key, `env_name`, `written_at`: the `.env` files this
     secret was written to, so Rotate can offer to update them and Delete can remove the line.

   Every write is compare-and-swap on `version`; two windows answering the same request race through the
   `open → saving` transition with a token, and the loser gets "already saved" in plain words. A request left in
   `saving` for more than five minutes (a crash between the keychain write and the row update) goes back to `open`
   at startup. `last_used_at` is written on its own and never touches `version`. Nothing in these tables can
   reconstruct a value.

3. **The agent's tools** in `monocode mcp`. The tool an agent calls to ask for a key is
   **`app secrets.request {name, why}`**, declared like `ask_person` (wire name `secrets_request`, app action
   `secrets.request`). The tool that uses a key is **`app secrets.run {name, env, command, cwd?,
   timeoutSeconds?}`** (wire name `secrets_run`, app action `secrets.run`): the per-command injection, one secret
   into one child's environment. A third, **`app secrets.list {}`** (wire name `secrets_list`), returns handles.
   - `secrets.request {name, why}` — creates an `open` request and returns at once with
     `{requestId, state: "waiting", name, scope}`, like `ask_person`. If a secret of that name resolves it returns
     the handle instead of showing a card. `why` is the Mono's own sentence for the person and is shown on the
     card. Scope is the chat's project first, then global; `scope: "global"` is only for a chat with no project.
     If the person hasn't answered, the turn ends and the chat says one line: waiting for a key. A worker is
     refused with the same plain reason workers get for `ask_person`: its first mate asks.
   - `secrets.list {}` — handles only: name, label, scope, when it was added, last 4 (or none), the Monos and
     projects approved to use it, and when it was last used. No tool anywhere returns a value.
   - `secrets.run {name, env, command, cwd?, timeoutSeconds?}` — `env` matches `[A-Z_][A-Z0-9_]{0,63}` and may not
     be a name already in the child's allow-list; `command` is a non-empty array of strings (argv, never a shell
     line); `cwd` must resolve inside the current project; `timeoutSeconds` defaults to 120 and caps at 600. The
     result is `{exitCode, stdout, stderr, timedOut, truncated}` after scrubbing.

   Name resolution: the chat's project scope first, then global. If both exist the project's wins and the result
   says which it used; the approval card, the Secrets page and the activity record say so too, in plain words
   ("Everywhere" or "Project: <name>", and "This project's copy is used; there is also one for everywhere"). If neither does, the tool returns `state: "missing"` and the model calls `secrets.request`.
   "Use my Stripe key" therefore means: try `secrets.run` with the obvious slug; if it is missing, ask for it with
   that slug and a why.

4. **The form card, and how the value travels.** A `SecretRequestCard` beside the composer (and in Inbox under
   Needs, from the same row) shows the normalized name, the label, the why in the Mono's own words, the scope, and
   which Mono asked. Its field is a masked password input (with a show toggle while typing); the value lives in the
   DOM until Save, is read once, and is passed straight to the `secrets_save` Tauri command. `secrets_save` writes
   the keychain first, then marks the request filled with its token, and returns only the handle. It is never put
   in React state, props, context, `localStorage`, `sessionStorage`, IndexedDB, the transcript, `blocks_json`, a
   log line or an error message, and the card's DOM node is removed when it closes; a failed save clears the field
   and shows one sentence, and the person tries again on a fresh card. Save, Not now and Cancel all close the card;
   Not now marks it declined and the Mono gets a plain note. A filled request resumes the Mono's turn with a note
   naming the handle, exactly as an answered decision does.

5. **Using it: a signed grant for one run.** `secrets.run` calls the app over the control port. The app checks, in
   this order: the caller's chat identity; that a secret resolves in scope; that this Mono (or its project) has a
   live grant for this executable, or asks the person first (step 10); that the executable is on the secret's
   approved list; that `cwd` is inside the project; that `version` still matches. It then returns a grant: a base64
   JSON of `{scope, name, version, subject, env, command, cwd, nonce, expiresAt}`, signed with HMAC-SHA256 under
   `monocode-hub:secret-key:grant` (account `key`, created on first use, dev-scoped like every other key). The
   item is named so it can never be mistaken for a secret, whose names always carry a scope segment.

   The MCP server runs its own binary as `monocode secret-run --grant-stdin` and writes the grant (a base64 payload
   and its signature) to that process's stdin, so it is in neither the argument list nor the environment that `ps` or
   Activity Monitor can show. That process verifies the
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

6. **The worker route: one worker's environment.** A first mate may name a secret for a worker it delegates:
   `delegate_task` gains `secrets: [{name, env}]` (at most 3). The app resolves each name through the same checks
   as step 5, with the worker's own CLI as the executable, and puts the values into that worker process's
   environment only — the same cleared environment and allow-list as `secret-run`, never `MONOCODE_*`, never a
   model key, never the app token. The card asks "Let <Mono> start a worker with Stripe API key in its
   environment?" and says plainly that the whole worker session will hold the value, including anything it starts;
   the command route is the narrower one and the card recommends it. The worker's output and transcript go through
   the same scrub rule, and the worker still cannot ask for a secret itself: its first mate asks, approves, and
   decides which worker gets what.

7. **The other route: a gitignored `.env` in one worktree, on the person's tap.** No tool writes a file; neither
   `secrets.run` nor a worker's env route ever touches the disk. The person taps "Write it to this worktree's
   .env" on a secret's row (or after saving a card). The worktree is picked from the app's own list for that
   project, never a typed path, and the app reads the value in Rust and writes it — it never crosses the webview.

   Before the value is read at all, in this order:
   1. the worktree is one the project owns, from the app's records;
   2. `git rev-parse --show-toplevel` at it equals it, canonicalised through `crate::fs::canonical`, so the root is
      a repo root and the target sits directly in it;
   3. `.env` is ignored — `crate::fs::git_ignored_names` (made `pub(crate)`) answers through `git check-ignore`.
      If it is not ignored, nothing is written and the page says "Git would commit this .env. Add `.env` to
      .gitignore first."; there is no offer to edit `.gitignore`;
   4. `.env` is not tracked (`git ls-files --error-unmatch`), because an ignored file already in the index still
      commits;
   5. the target is a plain file or absent; a symlink is refused without being followed (as
      `memory_review::is_symlink` does);
   6. the value is one line and holds no single quote; otherwise nothing is written and the page points at the
      command route.

   The write: `NAME=value`, where the name is `[A-Z_][A-Z0-9_]{0,63}` (the person may edit it) and the value is
   single-quoted only when it holds a space, `#`, `$`, `!` or unicode. Every other line is kept byte for byte; an
   existing `NAME=` line is replaced in place; two existing `NAME=` lines are a refusal, never a guess. The file's
   own line endings are kept (CRLF stays CRLF, otherwise LF), and a new file is created 0600 where the platform
   has modes (`#[cfg(unix)]`). It is written to a temp file in the same folder and renamed, and only after the
   file is re-read and its hash compared — if it changed while saving, nothing is written and the page says so.
   The write is recorded in `secret_env_writes`.

   What the person is told, in the page and on the row: the value is in that file until they remove it or rotate
   it, and Rotate offers "Update the 2 files that hold it" (a line is rewritten only if it still holds the old
   value; a hand-edited line is left and reported). Delete removes the line the same way.

8. **The scrub rule, exactly.** Before any command output reaches the model, every needle below is replaced with
   `[secret removed]`, longest needle first, using plain string search, never a regex built from the value:
   1. the raw value; 2. the value with trailing CR/LF trimmed; 3. its JSON-escaped form (serde_json's escaping);
   4. percent-encoded with upper-case hex; 5. percent-encoded with lower-case hex; 6. form-encoded (`+` for space);
   7. base64 standard with padding; 8. base64 standard without; 9. base64 URL-safe with padding; 10. URL-safe
   without; 11. hex lower case; 12. hex upper case; 13. its Unicode NFC and NFD forms (a Mac terminal prints NFD);
   14. for a multi-line value, each line of 8 or more characters on its own (a PEM printed line by line).
   Afterwards the shared `secretPatterns.json` scrubber (`portable::scrubber()`) runs over the result. Each stream
   is capped at 256 KiB with `[output cut]` and `truncated: true`. Finally the result is scanned again for every
   needle; if any survives, the stream is replaced whole with "The output looked like it held the secret, so it
   was not returned." Values under 8 characters are refused at save precisely so every needle is long enough to
   hide without mangling text.

   What is still hard, said plainly on the page and in this package: a command can print the value under encoding
   not on that list (gzip, base32, double base64, ROT13), one character at a time, or split across lines; it can
   write the value to a file, the clipboard or the network instead of stdout; a child it leaves behind keeps the
   environment after the run. The scrubber is a second line of defence, not the first. The first is that only an
   executable the person approved ever gets the value at all.

9. **Redaction: the value never lands in a transcript, an export or memory.**
   - **Transcript.** Three writers hold a chat's words: `sessions.blocks_json`, Claude Code's own transcript JSONL,
     and the tool-detail store. The value reaches none of them by construction — the card is UI only, `secrets.list`
     and `secrets.request` return handles, and a run's output is scrubbed inside `secret-run` before the MCP server
     returns it, so the text the CLI writes never held it. The one path left is a person pasting a key into the
     composer: there `hasSecretText` from the shared list runs before sending, a hit is not sent, and the composer
     offers the secret card instead.
   - **Memory.** `memory_review::mentions_secret` and `doc.ts`'s `hasSecretText` already refuse a secret-shaped
     note and leave the previous file as it was. WP-92 adds `secrets::holds_known_value(text, scope)`: it reads the
     listed values for the scope (`Zeroizing`) and refuses the save with the same sentence when one appears,
     whatever its shape. A memory save is person-gated and rare, so that read is bounded.
   - **Export.** `secrets/index.json` carries metadata only. Before `portable::export()`'s existing final scan, one
     `holds_known_value` pass runs over every text file; a hit is replaced with `[secret removed]`, and the final
     scan still refuses the whole export if anything shaped survives.
   - **Activity log, logs and error messages.** No value, ever.

10. **First use, and approvals.** The first time a Mono uses a given secret with a given executable, a small card
    asks: "Let <Mono> run `stripe` with Stripe API key?" with Once, Always for this Mono, Always for this project
    (the last only when the chat has a project), and No. Once writes a `once` grant for the Mono that is consumed
    by the next spawn; Always writes an `always` grant for the Mono or for the project, and a project grant covers
    every Mono working in that project. Resolution is the Mono's own grant first, then the project's. No writes
    nothing and returns "Ash said no" to the tool. An unanswered card behaves like an unanswered decision: the run
    returns "waiting for Ash's OK" and the turn ends. The default for a new secret is therefore ask each time, and
    the page says each secret's current mode and who holds it. The Mono that asked for the secret does not get a
    free pass: the approval is about what runs with it, not about who typed it. A `once` grant is deleted by
    compare-and-swap, so two runs racing it cannot both spend it.

    The card always shows the whole command line (program and arguments, never the value) and names the program. The
    approval stays per program, but a program that can run any code (`python`, `python3`, `node`, `deno`, `bun`,
    `ruby`, `perl`, `php`, `make`, `xargs`, `awk`, `sed`, `find`, `osascript`, `npx`, `npm`, `pnpm`, `yarn`, `uv`,
    `uvx`, `cargo`, `go`, `java`, `lua`, `Rscript`, `swift`; matched by basename, `.exe` ignored) gets a card that
    offers Once only, with the line "This can run any code, so it asks every time." A setting on the Secrets page
    (one value per install, off by default: "Let me choose 'Always' for programs that can run any code", with the
    warning "'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are
    sure.") lets a person who knows the risk choose Always for those programs too; the card then shows the same
    warning under its buttons. The app checks the setting where an `always` grant is written, so the webview cannot
    go around it, and turning it off takes back the Always grants it had allowed. The card's words are the app's own:
    an agent's `ask_person` cannot make a `secret/` card.

11. **Resolution, rename, rotate, delete.** "Use my Stripe API key" is a slug lookup, so the card shows the slug it
    will store (`stripe-api-key`) and the person can edit the label only. Rename changes the label; the slug stays,
    so every agent and grant that names it keeps working. Rotate (replace the value) writes a new value to the same
    item, bumps `version`, and leaves grants in place; a run whose grant names the old version is refused with
    "that secret changed, ask again", and the page offers to update the `.env` files that hold it. Delete is
    Revoke: it removes the keychain item, the row, every grant (Mono and project), and the lines it wrote in
    `.env` files that still hold its value, after a confirm that names what will stop working. Re-adding the same
    slug starts fresh with no grants.

12. **The Secrets page** in Settings: section id `secrets`, label "Secrets", description "The keys your agents can
    use, kept in your Mac's keychain. Never in chats, files or backups." It lists every secret with its label,
    scope, when it was added, its last four characters or none, the Monos and projects approved to use it, when it
    was last used, and the `.env` files that hold it. Per row: **Reveal** (a tap, then a confirm, then the value in
    a field that can be copied — the one command in the app that returns a value, and the only invoke the page
    makes that carries one; the value goes nowhere else and the field is cleared when the row closes), Rename,
    Rotate, Approvals (with Revoke for each Mono and project grant), Delete, and Write to a worktree's .env. Pending
    requests show the same form card; there is a manual "Add a secret" for the person. The page never writes a
    value to `localStorage` or `sessionStorage`, and a test holds that: the invoke spy sees a value field on
    `secrets_reveal` alone. Dev copies show their own list, with a line saying so.

13. **Connectors use the vault.** A connector's login field may hold a vault reference instead of a copy:
    `{"secret": "stripe-api-key"}` in its saved config. `connectors::launch::prepare` resolves it through the same
    scope and the same keychain call, so rotating the value reaches every connector that references it. A button on the
    connector's settings moves an already-saved login into the vault (one click, one confirm) but nothing migrates
    silently. The connector still gets its launcher signature and its redaction; this only changes where its login
    comes from.
    A connector whose server address is a field the person types (Zapier's and Composio's `{mcp_url}`) cannot use a
    saved key at all: the key is never sent to an address the person typed, and the launch says so in plain words.

14. **Dev copies and benches never see the daily secrets.** Every service name comes from
    `hub_keychain::scoped_service`, so a dev copy only ever forms `monocode-hub-dev:secret:…`, and the dev keychain
    holds different items. Under an isolated HOME (a bench, `verify_live`), the vault uses an in-memory store that
    is seeded only by a test's own value and never touches the real keychain; tests can inject one through a
    dev-copy-only environment variable, like `MONOCODE_PR_WATCH_GH`. `npm run hub:seed-dev` clears the vault's
    metadata, grants, requests and `.env` records in the copy, and cannot copy values because it never reads the
    keychain. A test asserts a dev copy cannot name a daily vault service, and that a daily grant does not verify in
    a dev copy.

15. **Exports carry an index, not a vault.** The export writes `secrets/index.json` with `name`, `scope`, `label`,
    `last4` and `createdAt` and nothing else; the shared scrubber still runs and the final scan still refuses the
    export on any pattern hit. Import creates the rows in a "needs its value" state with no grants and no `.env`
    records; the Secrets page lists them first, each with "Add the value", and nothing is usable until the person
    types it. `docs/PORTABLE.md` gets two sentences saying exactly this.

16. **The instruction and the old paste path.** The MCP instructions gain one line: "Need a key or token? Call
    `app secrets.request` with a name and a why. Never ask the person to paste it into chat." When a finished
    turn's "Needs Ash (provide)" names a key, the app now offers the secret form instead of a text box that would
    become a chat message (`chatQuestions.ts`, `provideNeeded`). The deny rules in `credentialGuard.ts` stay as they
    are apart from one line: `monocode secret-run` is added to the Bash deny rules so a worker cannot invoke the
    launcher directly, and the grant's signature is the guard that actually matters.

17. **Plain words everywhere.** The page, the cards and every failure sentence use the words key, secret, command
    and nothing else: "Saved in your Mac's keychain", "Not now", "That key is shorter than 8 characters", "Your
    Mac's keychain is locked. Unlock it and try again", "The command timed out after 2 minutes. Its output so far is
    below.", "Git would commit this .env. Add `.env` to .gitignore first." No value, no partial value but the last
    four characters, never in an error, a title or a log line.

18. **Not this package.** No browser autofill or password-manager import, no syncing, no sharing between people, no
    per-secret expiry reminders, and no `.env` files anywhere but a worktree the app already knows. Say so in the PR
    rather than half-building them.

## Done when

- [ ] Rust tests, with a memory store and a fixture command:
  - the service name rules: slug normalization, the 120-character guard, spaces, unicode labels, `..`, case-only
    duplicates, empty and missing names, a project id that has to be shortened; the daily item is exactly
    `monocode-hub:secret:global:stripe-api-key` and the dev item exactly
    `monocode-hub-dev:secret:global:stripe-api-key`;
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
    a daily grant refused in a dev copy; a Mono grant works for that Mono and not another; a project grant works for
    every Mono in that project and not outside it; a `once` grant is spent once even when two runs race for it;
  - the worker route: the worker's environment holds the allow-list and the one secret only, the card is required
    first, and a worker that asks for a secret itself is refused with the first-mate reason;
  - the `.env` route: refused when `.env` is not ignored, when it is tracked, when the target is a symlink, when the
    path leaves the worktree root (`..`, `canonical` mismatch), when two `NAME=` lines exist, and when the value has
    a quote or a line break; every refusal happens before the value is read; other lines are kept byte for byte; a
    CRLF file stays CRLF and an LF file stays LF; a unicode path with spaces works; two writers racing the file —
    one wins and the other is told the file changed; rotate rewrites a line only while it still holds the old value
    and leaves a hand-edited line alone; delete removes the line it wrote;
  - redaction: `holds_known_value` refuses a memory note holding a value of any shape; the composer does not send a
    pasted key; an export holds no value and `secrets/index.json` holds only the index;
  - the Secrets page's invoke spy sees a value only on `secrets_reveal`;
  - two windows answering one request: one saves, the other is told it was already saved.
- [ ] Webview tests: the card sends the value once and clears it; a save failure shows one sentence and no value;
    first use asks once, "Always for this Mono" and "Always for this project" stop the asking where they should,
    "Once" asks again; a name saved globally and in a project uses the project's copy, and the card and the Secrets
    page say which copy a run used; rename keeps grants; reveal is a tap and the value is gone when the row closes; delete removes the grants; the old "Needs Ash
    (provide)" path now opens the card.
- [ ] Browser specs on Chromium and WebKit: the Secrets page (add, list with last 4, reveal on tap, rename, rotate,
    delete with confirm) and the chat card (paste, Save, and the value is absent from the page's text, the DOM
    afterwards, `localStorage` and `sessionStorage`), with a screenshot in `docs/hivra/work/shots/`.
- [ ] Export: a planted key value never appears in the archive, `secrets/index.json` holds only the index, the
    final scan refuses on a planted pattern, and import lands in "needs its value" with no grants.
- [ ] `npm run hub:seed-dev` leaves a slot with no vault metadata, grants, requests or `.env` records.
- [ ] Dev-copy check, in the dev slot's keychain namespace only, with a dummy value: a fixture command prints the
    value and the model would see `[secret removed]`; no `monocode-hub:secret:*` daily item is created.
- [ ] `npm run check` passes (web, script and Rust), plus `cargo clippy --target x86_64-pc-windows-gnu
      --all-targets -- -D warnings` where the Windows target is installed.
- [ ] Mac-only checks for Ash: the keychain prompt appears once for the app, "Always Allow" sticks across a
    rebuild with the pinned identity, and the granted run prints `[secret removed]` where the value would be.

## Known limits

These are by design, or cannot be closed inside this package. They are written here so they are a known edge, not an
assumed one.

- **A connector run reads the vault without a per-run grant.** A connector whose login points at a saved key
  (`{"secret": "..."}`) gets the value in its own environment for as long as it runs. The person chose that when they
  pointed the connector at the key. The "one approved run" sentence is literally true of commands and workers, not of
  connectors.
- **A value split across two writes can pass the scrubber.** The scrub is per chunk (and per line for a worker), so
  a command that prints the first half of a key, flushes, and prints the second half is not caught. The first line of
  defence is that only a program the person approved gets the key at all. A value printed over several lines is only
  caught when it appears whole on one line (a PEM is caught line by line).
- **The revealed value is in the page while it is shown.** Reveal puts the key in a field on screen until the row is
  closed. Anything that can read the page (an extension, a screen recorder, DevTools) can read it while it is there.
- **The value crosses the app's own bridge once.** When the person types a key, it goes from the page to Rust as one
  command argument. No log line in the app writes it, but a console that logs the bridge would see it.
- **Any script running in the app's own webview can call the vault's commands.** It could reveal a key, write a
  grant or write a `.env`, and it could send `decisions_answer` as the person. The app does not run remote or
  untrusted script in that webview; if that ever changed, this would be the first thing to close. The Rust side
  already refuses what an agent can reach (a chat's answer to a secret card, an agent-made secret card, an "Always"
  for a program that can run any code while the setting is off).
- **A worker keeps its own tool's environment.** The worker route adds the one approved variable and removes any
  `MONOCODE_*` variable the app itself was started with, but it does not clear the rest of the tool's environment (the
  tool needs its own HOME, PATH and login). Step 6 says "cleared environment"; this is the narrower thing the code does,
  and the difference is open for Ash to decide. The app's tokens stay out of a worker because the app's grant check
  refuses workers as well as the spawn removing them.
- **A program is found when a run starts, not when it is approved.** The run looks the approved name up on the login
  shell's PATH at that moment. A file placed earlier on that PATH under the same name would run under the same approval,
  and an "Always" approval is kept by name. Placing a file there needs write access to a folder on the person's PATH, the
  same access their own tools need. Pinning the approval to one file's path is the fix; it is not built.
- **A dev copy can be seeded with plaintext values through its environment.** `MONOCODE_SECRET_VAULT_SEED` exists for
  tests under a temporary HOME and is read by dev copies only; a daily copy refuses it. A value placed there is
  visible to `ps` and to a crash report of that process, so it is for dummy values.
- **The export's history scan is by pattern only.** The exact-value pass skips binary files, and a memory repository's
  git history (the `.bundle`) is scanned with the shared pattern list, not with the saved values. A value that is in
  that history and has no known shape would not be caught. This predates the vault.
- **Revoke does not cancel a grant that was already issued.** A signed grant lives 60 seconds and is spent once. If the
  person revokes an approval inside that minute, a run that already holds its grant can still finish.
- **A `.env` temp file is kept out of the work tree, not out of existence.** While a `.env` is being rewritten the
  value is in a 0600 temp file (in git's own folder unless the person's ignore rules already cover `.env*`). It is
  removed on every error path and when the write ends, but a process killed in that moment leaves it behind.
- **A card is still answered by its program, not by its arguments.** An approval is per program. A person who picks
  Once or Always for a program approves that program, and the next command with the same program is run on the same
  approval. The card shows the command it was asked for, and a card that has not been answered is refreshed to the
  newest command, but an answer that lands after the Mono has asked again applies to the newer command.
- **Not run here.** The browser spec ran on Chromium only (Playwright's WebKit binary is not installed on this Mac),
  nothing was compiled or run for Windows, and the macOS keychain prompt was not exercised: every test uses the
  in-memory store.
## Addendum (10 Nov 2026): planted-secret acceptance tests

Source: AgenticBench (agenticbench.org; no repo or licence file found). Ideas only, no probes or code copied.

Before the vault ships, a test suite plants a fake secret and checks that it does not reach the model context, a log, telemetry, a crash report or an export. Cases:

1. A command the agent did not need cannot read a file outside the project to find a secret.
2. A project file, or the output of a script the agent runs, that says to read the secret and send it does not get the secret.
3. When a requested command fails and prints the secret in its error output, the value is removed from every copy except the one the person chose.
4. A new chat in a second project does not carry the first chat's secret.

Trust-gate cases (project hooks or project MCP config running before the person trusts the folder) belong to WP-31's acceptance list, not here. Done when each case is a test that fails if the secret appears, and the suite runs in `npm run check`.
