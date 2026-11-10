# WP-90: Every worktree gets its own web address, and its tests meet a fake service, not a real one

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| J | L | 82, 87 | yes |

## Goal

When two crews run the same project side by side, each worktree's app opens at its own name, such as
`shop.wp-90.localhost:7400`. Any outside service its tests use (GitHub, Google, Stripe, Slack and the rest) comes
from a local stand-in that keeps its own accounts and state for that worktree. Cookies, sign-ins, OAuth callbacks and
CORS stay inside one worktree, no test ever reaches a real outside account, and the daily app's ports are never
touched.

## Why

Ash, 5 Nov: he found [portless](https://github.com/vercel-labs/portless) and
[emulate](https://github.com/vercel-labs/emulate) (both Apache-2.0; read at commits `7461383` and `1566b8e`), and
asked whether they would let parallel agents run apps and browser-test without colliding on ports, cookies,
hostnames or shared outside accounts.

**Ports: yes, and WP-87 already covers it.** A worktree's stack gets a block of free ports, and no two stacks share
one. Nothing in this package changes that; it feeds off it.

**Cookies and hostnames: not with ports alone, and that is portless.** A port is not an origin. Cookies ignore the
port, so `localhost:3001` and `localhost:3002` are one site: signing in as a test buyer in one crew's app replaces the
other crew's session, and neither can keep a logged-out state. The same collision hits OAuth redirect URIs (a provider
matches `http://localhost:3000/api/auth/callback` exactly, so it works for one worktree and no other), CORS
allowlists, CSP origins, service workers and IndexedDB. A stable name per worktree fixes all of them at once and gives
the task card a URL worth clicking. portless has already worked out the hard parts: a registry of names to ports with a
file lock and removal only by the process that added the name, a name derived from the worktree and kept inside 63
characters, and a local proxy that reads the `Host` header.

**Outside accounts: only if the app is pointed at the stand-in, and that is emulate.** It runs 14 stateful services
(GitHub, Google, Stripe, Slack, Microsoft, Okta, AWS, Clerk, Linear, Twilio, Resend, Apple, Vercel and MongoDB Atlas)
with real OAuth code flows, signed Stripe and Slack webhooks, seeds, reset and snapshots. It does **not** intercept
traffic: the app must be configured with its base URLs. That is exactly why this package belongs next to WP-87: Hivra
owns the stack's environment block, so it can write the stand-in's URLs in, and then the safety rule is enforceable
rather than advisory. A crew's stack either names an emulated service or does not start.

**Taken from portless:** the registry with its lock and its owner-only removal, the label rules, port allocation and
the free-port probe, the blocked-port list, the `Host`-routing proxy with its upgrade path, and the unprivileged mode's
habit of leaving the machine alone (no hosts file, no CA, no root). Not taken: TLS, the hosts-file sync, the CLI's app
launcher, and its worktree-prefix guess (Hivra always knows its stack id).

**Taken from emulate:** the 14 services as a pinned package, seeds, reset and snapshots, the base-URL precedence with
`{service}`, and the atomic 0600 store. Not taken: `--portless`'s global aliases, its default consecutive ports (the
stack block owns ports), and the example config's hard-coded `localhost:3000` redirect URI.

**What it replaces in WP-87:**

- Step 3's "the task card links the running app's local URL": that URL is now the worktree's named URL, not
  `localhost:<port>`. It is stable across restarts and safe to open on a phone.
- The env block gains the named app URL and one base URL per emulated service. The stack's `status` shows each
  service's name, its port and whether it is emulated.
- Its Done-when "two worktrees get different ports" is unchanged; add "and different names". Its registry stays the
  owner of ports; this package adds the names.
- WP-87's "no Docker is fine" still holds: the proxy and the stand-in need none.

**What it replaces in WP-82:** a pool slot's name is derived from the slot id, not the branch, so a slot that is
returned and leased again keeps its hostnames and its stand-in's state. That is the point of a warm slot: the next
crew starts already signed in to the fake account its tests expect. WP-82's return step also stops the stack (WP-87)
and now removes its names, and only its own.

**Honest limits.** A real provider that calls back from the internet (a Stripe webhook, a Google sign-in the person
finishes in their own browser) cannot be emulated; that is the delivery gate's job against the real service (WP-81),
never a crew run's. An app that hardcodes `https://api.github.com` and ignores its environment cannot be redirected;
the stack says so plainly instead of pretending, and that stack is not run unattended.

## Read first

- portless at `7461383`: `packages/portless/src/routes.ts` (the registry, its lock and owner check),
  `auto.ts` and `config.ts` (`sanitizeForHostname`, `truncateLabel`, `detectWorktreePrefix`, `applyWorktreePrefix`),
  `compose.ts` (`planCompose`, `allocatePorts`), `proxy.ts` (routing by `Host`, the upgrade path),
  `cli-utils.ts` (`findFreePort`, `BLOCKED_PORTS`), and their tests.
- emulate at `1566b8e`: `packages/emulate/src/base-url.ts` (the precedence and `{service}`),
  `commands/start.ts` (ports, `--base-url`, `--portless`), `packages/@emulators/core/src/persistence.ts`
  (`wx` at 0600, fsync, rename, `link()` for create-or-read), `registry.ts`, `mcp.ts`,
  `emulate.config.example.yaml`, and the README's "explicit configuration, no interception".
- Hivra: WP-87 (the stack declaration, port block, env block, `status` and `down`), WP-82 (the pool and slot ids),
  `src-tauri/src/project_actions.rs` (`start_command`'s `env` seam, the child's own process group and credential
  scrub), `src-tauri/src/harness.rs` (the scrub list), `src-tauri/src/browser/mod.rs` (WP-43 per-agent browser
  profiles), `src-tauri/src/pinned_tool.rs`, `scripts/hub-dev.mjs` (the 1430 grid that must stay Hivra's own).

## Build

1. **Names and their registry, translated from portless.** Port `routes.ts` line by line to
   `src-tauri/src/proxy/routes.rs`, keeping the mkdir lock (10 s stale, 15 s wait), `addRoute` with its optional
   force for a name a dead process left behind, `removeRoute(hostname, owner_pid)` that only removes a name its own
   process added, and `pruneStaleRoutes()`. Port its tests. One registry per copy, in `<data>/proxy/routes.json`, with
   a lock file and the writer's pid; a second window sees the proxy already running and uses it instead of starting
   another.
   Why a translation and not the package: the proxy has to outlive the window and the registry is written by WP-87's
   Rust, and portless's TypeScript cannot run inside Rust's process. Those five files total about 3,000 lines; only
   the registry, the label and port helpers and the routing core are taken, roughly 1,200, and the rest (TLS, the
   hosts file, the CLI's app launcher) is left out.
2. **Labels.** `sanitizeForHostname` and `truncateLabel` (63 characters, a `-` and six hex digits of the SHA-256 when
   shortened) carried over as they are. The label comes from the **stack id** (WP-87), not from the branch, so a pool
   slot keeps its name when re-leased; a stack outside the pool falls back to its worktree's branch. portless's
   "only prefix when the repo has more than one worktree" rule is dropped on purpose: Hivra always knows which
   worktree it is. Names are lowercase, no `..`, no path separators, no wildcard, and a name that fails the check is
   refused rather than repaired. Spaces, unicode and Windows paths therefore cannot reach the registry as a name.
3. **Ports.** `allocatePorts` and the four-address probe (127.0.0.1, ::1, 0.0.0.0, ::) carried over, plus the
   WHATWG blocked-port list. The reserved list is the daily app's and Hivra's own: 80, 443, 1420, 1421, the dev-slot
   grid 1430–1919, and every port this copy is already using (control port, harness ports, proxy port, emulator
   ports). Ports come from WP-87's block and are never guessed; the probe only confirms a port is still ours.
4. **The proxy.** One per copy, started with the app and left running: a small HTTP/1.1 forwarder in
   `src-tauri/src/proxy/server.rs` on `std::net` threads (no new crate). It binds 127.0.0.1 and ::1 only, never
   0.0.0.0. It reads the request line and `Host`, takes the port from the registry, and forwards the bytes unchanged,
   so WebSocket upgrades (Vite's HMR, most dev servers) pass through both ways. Plain HTTP only: no TLS, no
   certificate, no CA installed, no `/etc/hosts` write, no sudo — `.localhost` resolves to loopback by itself
   (RFC 6761), and every generated URL carries the proxy's port.
5. **The proxy is not an open door.** An unknown `Host` gets 404, not a default route. A request in absolute form
   (`GET http://example.com/…`), a `Host` with userinfo, a path or a second `Host` header is refused. No request or
   response header (above all `Authorization`, `Cookie`, `Set-Cookie`) is ever logged; the log says hostname, method,
   status and milliseconds. A name is removed only when its owner pid is the process asking and that pid is still
   alive; a stale name whose port is listening on nothing is pruned on start.
6. **The stand-in, as a pinned tool.** emulate is an npm package and requires Node 24; install its tarball at a pinned
   version into `<data>/tools/emulate/<version>/` with the tarball's SHA-256 checked by the shared download-and-verify
   code (WP-81, WP-82). Not vendored: 14 services' behaviour would be a large translation that drifts from upstream's
   signed webhooks and OAuth flows, and it must run as a Node process outside the webview anyway. Translate the two
   parts Hivra must own, with credit: `base-url.ts`'s precedence (a service's own seed URL, then the explicit
   `--base-url`, then `EMULATE_BASE_URL`, then `PORTLESS_URL`, then `localhost:<port>`, with `{service}` replaced)
   into `src-tauri/src/local_services/base_url.rs`, and `persistence.rs`'s rules (write `wx` at 0600, fsync, rename;
   `link()` for create-or-read) into `src-tauri/src/local_services/store.rs`, with emulate's tests ported. If Node is
   missing or older than 24, the stack starts without the stand-in and says so once; the base URLs still point at the
   service's own loopback port, so a test fails closed (connection refused) instead of quietly reaching the real service.
7. **Wiring it into the stack (WP-87).** A stack's declared service may name an emulated one
   (`{ "emulate": "github", "urlEnv": "GITHUB_BASE_URL" }`). Hivra writes each emulated service's port into the
   generated emulate config (it honours a per-service `port`), registers `<service>.<project>-<label>.localhost` for it
   (the project is in the name so two projects on one branch never share one, and the service is a label of its own
   so no hyphenated project or branch can read as it: project `github-shop`'s app on branch `a` is
   `github-shop-a.localhost`, project `shop`'s fake GitHub is `github.shop-a.localhost`; two project folders with the
   same name each add a short hash of their path), and puts `http://127.0.0.1:<port>` in
   the stack's env block under `urlEnv`, defaulting to `<SERVICE>_BASE_URL`: server-side code resolves names through
   the OS, which does not treat `*.localhost` as loopback. The named URL is what the stand-in advertises (its
   `baseUrl`, links and redirects) and what a browser opens through the proxy. A name another stack holds is refused,
   and only the stack that holds a name removes it. The app itself
   gets `<project>-<label>.localhost` and `PUBLIC_URL`; the framework-specific names the project already declares
   (`PORT`, `VITE_PORT`, and so on) keep working. One stand-in process per stack, never `--portless`: emulate's
   `--portless` registers a global `<service>.emulate` alias with `--force`, so two worktrees would overwrite each
   other's. The per-stack port and name are the whole isolation.
8. **State per worktree.** Seeds and snapshots live with the stack, not in the worktree, and `stack reset` puts the
   stand-in back to its seed between runs. A pool slot keeps its state (WP-82); `stack down` stops the stand-in, the
   app's processes and removes its names, and a stack whose worktree is gone appears in Clean up, removed only with a
   tap. A name or stand-in left by a crash is pruned on the next start, never silently re-pointed at a port now owned
   by something else: the app stops every stand-in it started when it quits and again at the next start. A stand-in is
   stopped only when it is provably the one the app started: the start time recorded when it was spawned (macOS
   `proc_pidinfo`, Linux `/proc/<pid>/stat`, Windows `GetProcessTimes`) is found again on the live process, the program
   is node, and where the command line can be read it runs `--seed <stack>/emulate.config.json`. A pid file with no start
   time is never signalled. After SIGTERM the stand-in's process group is watched and gets SIGKILL only if it is still there
   at every look through the wait (a group id in use cannot be another program's, so a child that ignores SIGTERM is
   ended even when its leader is gone, and a group that has gone is never signalled again). The pid file is removed
   only if it still says what the stop read. On
   Windows each stand-in is in a Job Object of its own that ends with the app, and stopping ends the whole tree; a stop
   that leaves one of its ports answering keeps the pid file. At launch this runs in the background (a stack action
   waits for it), `node --version` has a five second limit, and for a stack that was still running the app starts that
   stack's fakes again and puts their names back. The app's own name comes back only while its port answers and Docker
   says this stack's own containers publish it; any other listener, or a Docker that cannot be asked, leaves it
   unpublished. A name that was not put back (Docker still starting, a port something else holds, a name list that could
   not be used) stays with its stack and the card says why, and only a name another stack really holds is dropped from
   this one.
9. **On screen and by chat.** The stack's card shows each name, whether it is emulated, and one line saying which
   mode it is in ("tests use fake GitHub and Stripe" or "reaches the real internet"). The task card links the named
   app URL. `app stacks` reads the same; a crew is told the app's named URL in its brief.
10. **Safety, written down as tests.** A crew run's child process gets the existing credential scrub (harness and
    project-actions scrub lists) and an env block that names only emulated hosts. A declared service pointed at a real
    host (`api.github.com`, `api.stripe.com` and the rest) refuses to start unless the project is marked
    `reaches: real`, and a `reaches: real` stack cannot be started by a crew turn, only by the person. Crew browser
    pages use the WP-43 per-agent profile, so the person's own cookies never meet a crew page. Everything read from
    the stack file, the generated config or the registry is validated (names, ports, URLs) with a safe fallback;
    values on disk are untrusted.
11. **Dev copies and Windows.** A dev copy gets its own proxy port (default 7400, the next free one above it) and its
    own registry in its data folder, never the daily app's; it refuses to publish a name on the daily proxy's port.
    Windows: `std::net`, `.localhost` and the registry work unchanged; the 0600 file mode is `#[cfg(unix)]`, with a
    Windows equivalent (an ACL grant to the owner) or a skipped test under `#[cfg(windows)]`.

## Copy with credit

portless and emulate are both Apache-2.0 (Copyright 2025 Vercel Inc. and Copyright 2025 Chris Tate).
`docs/hivra/credits.json` already lists both components as planned ("Planned for WP-90, code not copied yet"). The
licence header on each translated file and the `credits.json` component stay with the code; the `NOTICE` entry is
added in the PR that copies the code, not before, so the file never claims code the tree does not have.

## Done when

- [ ] Tests (portless's tests ported where it has them):
  - the registry: two names coexist; a removal with the wrong owner pid is refused; a dead owner's name is pruned; a
    lock held past 10 s is taken over; two writers never lose an update;
  - labels: two worktrees differ; the same worktree gets the same name after a restart; a pool slot keeps its name
    across a return and a new lease; a 200-character branch truncates to 63 with its hash; spaces, unicode, `..`, a
    Windows path and an empty name are refused;
  - ports: a block never includes a reserved or blocked port; the probe sees a port taken on each of the four
    addresses;
  - the proxy: routes `Host:port` to the right port; 404 for an unknown name; an absolute-form request line, a
    userinfo `Host` and two `Host` headers are refused; a WebSocket upgrade passes bytes both ways; the bound address
    is loopback only; the log line carries no header.
- [ ] Stand-in tests (emulate's tests ported where it has them): config generation puts each service's port from the
  block in the seed; the base URL precedence, `{service}` replaced; a declared real host refuses without
  `reaches: real`; a `reaches: real` stack refuses a crew caller; the state file is 0600; a seed file on disk that is
  invalid or missing falls back to the default seed and says so.
- [ ] Browser specs (Chromium and WebKit): two worktrees of a fixture app, both running; a cookie set in one is absent
  from the other; a sign-in against the emulated GitHub completes and its redirect URI is the same after a restart;
  the task card's link opens the named URL; the stack card says which services are fake.
- [ ] WP-87's tests still pass with names, including `status` and `down`; a returned pool slot's names are gone.
- [ ] No daily-app interference: a dev copy's proxy port and registry differ; a stack can't take 1420, 1421 or a port
  in 1430–1919; nothing writes `/etc/hosts`, binds 80/443, or asks for sudo.
- [ ] Windows runner: the registry, label, port and proxy tests pass (the 0600 test skipped or replaced).
- [ ] `npm run check` passes.
- [ ] Dev-copy check: two worktrees of a small fixture app run at once; the PR shows both names, both cookie jars and
  the emulated sign-in.
