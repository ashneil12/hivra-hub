# WP-90: Every worktree gets its own web address, and its tests meet a fake service

## What changed

- **Names (portless, Apache-2.0).** `src-tauri/src/proxy/` now holds the translated route
  registry, label rules, port allocation and the loopback proxy:
  - `labels.rs`: `truncateLabel` and `sanitizeForHostname` from `auto.ts`, plus the
    app/service hostname composition, `<project>-<label>.localhost` and
    `<service>-<label>.localhost`. A name that fails the check is refused, never repaired.
  - `routes.rs`: `routes.ts` translated line by line: `<data>/proxy/routes.json`, the mkdir
    lock (10 s stale, 15 s wait), `addRoute` with `force`, `removeRoute(hostname, owner_pid)`,
    `pruneStaleRoutes`, and the pid liveness check (`libc` on Unix, `OpenProcess` on Windows).
  - `ports.rs`: the WHATWG blocked-port list, the four-address free-port probe from
    `cli-utils.ts`, `nextFreeFrom`, and `allocatePorts` from `compose.ts`.
  - `server.rs`: `proxy.ts`'s routing core on `std::net` threads, no new crate: one listener
    per copy on 127.0.0.1 and ::1, `Host` routing, 404 for an unknown name, refusals for an
    absolute-form request line, CONNECT, a userinfo/path `Host`, two `Host` headers, duplicate
    `Content-Length` and `Content-Length` plus `Transfer-Encoding`, and WebSocket upgrades
    passed through both ways. The log has hostname, method, status and milliseconds only:
    no header is ever passed to it.
  - `lib.rs` starts the proxy once per copy; `env_from_app` uses it. A dev copy keeps its own
    registry in its own data folder and takes the next free port above 7400, never the daily
    app's.
- **The stand-in (emulate, Apache-2.0).** `src-tauri/src/local_services/`:
  - `base_url.rs`: `base-url.ts`'s precedence (seed URL, explicit, `EMULATE_BASE_URL`,
    `PORTLESS_URL`, `localhost:<port>`) with `{service}` replaced.
  - `store.rs`: `persistence.ts`'s rules: `wx` at 0600, fsync, rename; `link()` for
    create-or-read. The 0600 test is Unix; Windows keeps the profile folder's ACL and has its
    own test.
  - `emulate.rs`: the 14 service names, seed config generation (each service's port from the
    stack block, its named base URL, the default token), merge of a stack's own seed with the
    block's ports always winning, invalid/missing seed fallback with a one-line notice, the
    Node 24 check, the pinned-tarball installer (SHA-256 checked before unpacking, path
    traversal refused), one stand-in process per stack with an allow-listed environment, and
    a stop that only kills a pid whose command names this copy's program.
- **Stacks (WP-87) carry the names.** `stack_decl.rs` gained `emulate` and `urlEnv`;
  `project_file.rs` gained `reaches: "emulated" | "real"`. `stacks.rs` assigns each emulated
  service a port from the same block, writes `PUBLIC_URL` and one base URL per service into
  the env block, publishes the names before anything starts, starts the stand-in, and on
  `down`, a pool return or stale removal stops the stand-in and removes only its own names.
  `stack reset` returns the stand-in to its seed without moving names or ports. Labels come
  from the stack id inside a `worktree-pool`, so a returned slot keeps its names and state;
  elsewhere the worktree's branch is used.
- **Safety.** A declared service that names a real host refuses to start unless the project
  says `reaches: real`, and then only `trigger == "app"` (the person) may start it; a crew's
  `actions.run` is refused. Registry, seed and stack values read from disk are validated with
  safe fallbacks.
- **Credit.** Licence headers on every translated file, two NOTICE entries, and the
  `docs/hivra/credits.json` components changed from planned to shipped.

Not copied: TLS, HTTP/2, the hosts file, sudo, portless's CLI/app launcher, tunnels, the
worktree-prefix heuristic, `--portless` and its global aliases, and emulate's 14 emulators
(they run as the pinned Node package). `planCompose` was not copied; WP-87 already owns
Compose.

## Why

A port is not an origin. Cookies ignore the port, so two crews on `localhost:3001` and
`:3002` share one session and one OAuth redirect URI. A stable name per worktree fixes
cookies, redirect URIs, CORS, CSP, service workers and IndexedDB at once, and gives the task
card a URL worth clicking. Outside services are only isolated if the app is pointed at a
stand-in; because Hivra writes the stack's env block, that is enforceable rather than
advisory.

## UI

- The stack card now lists each published name, marks the fake services (`github-wp-90.localhost
  (fake github)`) and shows one mode line: `Tests use fake GitHub and Stripe`,
  `Reaches the real internet`, or `No outside services`. A stand-in that could not start
  shows its one-line note. **Reset fake services** restarts it from the seed.
- The task card's **Open the running app** link now opens the named URL; `appLink` accepts
  `<name>.localhost` as well as loopback, and still refuses anything else.
- `app stacks` (`stacks.list` in the app CLI) returns the same rows for a crew: names, ports,
  emulated services and the mode.

## Checklist (the package's Done when)

- [x] **Registry tests.** `two names coexist`; `a removal with the wrong owner is refused and
  the right one works`; `a dead owner's name is pruned and force may replace it`; `a live
  owner is never taken over even with force`; `a lock held past the stale threshold is taken
  over`; `two writers never lose an update`; `a name that is not a hostname or a corrupt file
  is refused safely`.
- [x] **Label tests.** `two worktrees get different names and the same one after a restart`;
  `a pool slot keeps its name when returned and leased again`; `a two-hundred-character
  branch becomes 63 with its hash`; `spaces, unicode, .., a Windows path and an empty name
  are refused`; `a hostname is made of valid labels...`; `sanitize repairs...`; `a main or
  missing branch falls back to the stack id`.
- [x] **Port tests.** `the blocked list is sorted and contains the browsers' bad ports`;
  `a block never includes a reserved or blocked port`; `allocation skips reserved and taken
  ports and keeps a stored one`; `a stored port other projects reserved is not reused`; `the
  probe sees a port taken on each of the four addresses`; `the next free port skips reserved
  ones`.
- [x] **Proxy tests.** `routes the host to the right port`; `an unknown name is a 404, not a
  default route`; `absolute form, userinfo and two Host headers are refused` (plus CONNECT
  and two framings of one body); `a WebSocket upgrade passes bytes both ways`; `the bound
  addresses are loopback only`; `the log has the host, method, status and ms but no header`;
  `the health path proves which proxy holds the port`; `a dev copy reads the daily port so it
  can avoid it`.
- [x] **Stand-in tests.** `the config puts each service's block port and named URL in the
  seed`; the base-URL precedence and `{service}` replacement; `a valid seed keeps its own keys
  but never its ports`; `a missing or invalid seed falls back to the default and says so`;
  `a real host is recognised and a lookalike is not`; `a declared real host refuses without
  reaches: real and a crew never starts one`; `the state file is 0600` (Unix); `the install
  refuses a missing pin`; `a tar entry that escapes the folder is refused`.
- [~] **Browser specs.** `wp90-names.spec.ts` passes on Chromium (names, fake services, mode,
  task-card named link). `wp90-cookies.spec.ts` passes on Chromium: a cookie set under
  `one.localhost:port` is absent under `two.localhost:port`. The emulated-GitHub sign-in and
  restart-stable redirect URI could **not** be exercised: this Mac has Node 22.23.4, emulate
  needs Node 24, and there is no network to fetch its tarball. WebKit could not run (its
  browser binary is not installed here). Both are listed for Ash below.
- [x] **WP-87's tests still pass with names**, including `down` and `status`:
  `a named stack publishes its app and fake services with the block's ports` asserts the named
  URL, three names and the mode; `down removes only this stack's names and stops its stand-in`;
  `a returned pool slot has its names removed from the real registry`; `reset puts the stand-in
  back without moving its names`; `a pool slot keeps its name and state across a return and a
  new lease`.
- [x] **No daily-app interference.** `a dev copy reads the daily port so it can avoid it`;
  `a dev stack takes ports from the dev range only` (42,000–47,999, never 80/443/1420/1421/
  1430–1919); `a block never includes a reserved or blocked port`; the proxy binds loopback
  only and the code contains no hosts-file write and no sudo.
- [~] **Windows runner.** Registry, label, port and proxy code is platform-gated; the 0600
  test has a `#[cfg(windows)]` counterpart. The Windows target is not installed on this
  machine, so the Windows test run was **not** made.
- [ ] **`npm run check`** was not run in full, per this run's machine-sharing rule; only the
  targeted commands below were run. The lead runs it once.
- [~] **Dev-copy check.** Not run here: this run may not launch the app or a Tauri build. The
  parts that do not need a window are covered by the tests above; the live two-worktree check
  is in the Mac-only list.

## Commands run and what they printed

```
cargo test --manifest-path src-tauri/Cargo.toml proxy::            31 passed, 1891 filtered out
cargo test --manifest-path src-tauri/Cargo.toml stacks::           43 passed, 1 ignored, 1877 filtered out
cargo test --manifest-path src-tauri/Cargo.toml local_services::   16 passed, 1904 filtered out
cargo test --manifest-path src-tauri/Cargo.toml stack_decl          4 passed, 1918 filtered out
cargo test --manifest-path src-tauri/Cargo.toml project_file       14 passed, 1908 filtered out
cargo test --manifest-path src-tauri/Cargo.toml control_cli        15 passed, 1907 filtered out
cargo test --manifest-path src-tauri/Cargo.toml project_actions     4 passed, 1918 filtered out
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
                                                                   No issues found
cargo fmt --manifest-path src-tauri/Cargo.toml --check              (no output: clean)
npx tsc --noEmit                                                   (no output: clean)
npx vitest run src/features/stacks ... agentAppActions.test.ts     4 files, 12 tests passed
npx playwright test tests/browser/wp90-names.spec.ts --project=chromium    3 passed
npx playwright test tests/browser/wp90-cookies.spec.ts --project=chromium  1 passed
npx playwright test tests/browser/wp87-stacks.spec.ts --project=chromium   4 passed
npx playwright test tests/browser/wp90-names.spec.ts --project=webkit
    3 failed: "Executable doesn't exist ... npx playwright install" (WebKit not installed)
```

## What I could not check, and why

- **Emulated sign-in end to end.** No Node 24 on this Mac and no network for emulate's
  tarball. `TARBALL_SHA256` is deliberately empty, so the installer refuses instead of
  trusting an unverified download; until the pin is filled, a stack starts with a note and
  its named URLs fail closed rather than reaching a real service. This is the one release
  step left for the stand-in.
- **Two worktrees of a fixture app running side by side.** Requires launching the app, which
  this run may not do. The registry, name, proxy and cookie rules are unit- and
  browser-tested; the live check is for Ash.
- **WebKit.** Its Playwright browser binary is not installed.
- **Windows.** The target is not installed; platform code is `cfg`-gated and the 0600 test is
  replaced, but the Windows run was not made.
- **Full `npm run check`.** Left to the lead by this run's rules.
- **Snapshots.** Seeds live with the stack and `stack reset` re-seeds the stand-in; emulate's
  snapshot/restore CLI is not wired to a command yet.

## Mac-only checks for Ash

1. `npm run hub:dev -- --seed`, open two worktrees of a small fixture app, and check both
   named URLs answer, sign-in state stays separate, and the task card opens the right name.
2. With Node 24 installed, fill emulate's tarball pin, sign in through the fake GitHub, then
   restart the app and confirm the same redirect URI completes.
3. Open one named URL on the phone (same Wi-Fi) to confirm `.localhost` names stay on this
   Mac only.
