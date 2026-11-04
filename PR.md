# WP-44: Desktop control

Desktop control stays off until the person turns it on. After that, each app is asked for once per project, and visible control stays off until they allow it. This round is what makes that possible to turn on: the program can be fetched, the pin covers each platform, and the project comes from the app rather than the tool call.

## What changed

`plugins/desktop-control/pin.json` is filled in. It names agent-desktop 1.1.0, the registry tarball, npm's sha512 integrity, and a sha256 for each platform key (`process.platform` + `process.arch`): darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64. Darwin and Linux also pin the helper. Windows does not have one.

**Get the desktop program** sits beside Install desktop control, and on the installed row once that button is gone. It does one download, of `https://registry.npmjs.org/agent-desktop/-/agent-desktop-1.1.0.tgz`. If the installed pin's url or integrity is not that pair, nothing is downloaded. The bytes are checked against npm's integrity (`sha512-4aITRplPcbV6xBFNKeehMbxSN0/L+IOhnn6LBuPXezoyr08Xl73Y6rwZiR4sM4rM/eBO6iJMoKL+IvFQvHwLEw==`). Only this platform's binary and its helper are taken from `package/bin`. Each file's sha256 is checked against the pin. They are written into `data/desktop-control/` as `agent-desktop` (`agent-desktop.exe` on Windows), with the helper beside it, mode 755. The package's postinstall is never run. A wrong integrity, a wrong file hash, or an archive entry whose path leaves the folder is refused and nothing is written. A failed download says to try again. It is not treated as a final answer.

Before every start the gate checks the binary, and on macOS and Linux the helper, against this platform's pin entry. On macOS it sets `AGENT_DESKTOP_MACOS_HELPER_PATH` to the helper in the data folder. That name is on the allow list, and a worker's value is replaced. On Linux the helper sits beside the binary as `agent-desktop-linux-clipboard-owner`.

The project comes from the app's launch (`DESKTOP_LAUNCH_PROJECT`), not from the tool call. A worktree is mapped to its repository's main checkout, so an allowed project is not asked again in a worktree. `project` is not in the tool's input. A call that still names a different folder is refused, and that refusal does not create a pending ask.

## Done when

- Tests for install, a consent prompt on a new app, and refusal when off, with a stubbed binary. The install cases are in `src-tauri/src/plugins/desktop_tests.rs` (wrong integrity, wrong file hash, a path that leaves the archive, a good archive, a download stand-in that is not the network). Consent and the off switch are in `src/features/plugins/model/desktopControl.test.ts` and `tests/browser/wp44-desktop.spec.ts`. `cargo test --lib plugins::desktop_tests` passed earlier in this round (20 tests). The gate file passed in the full web run below (54 tests in that file).
- The spike (can agent-desktop read Hivra's own window) was not checked live.
- `npm run check` passed. See below.

## Residual risk

The gate is a consent guardrail, not a security boundary. It stops an agent using desktop control by accident or without the person's yes. It does not stop a worker that deliberately runs the binary, or other desktop tools (osascript, screencapture), through its shell, because a worker already has a full shell as the same macOS user. Real isolation needs an OS sandbox or a separate user, which is a later package (for example with Hivra Cloud).

## Commands

`npm run check` (vitest, `tsc --noEmit`, `node --test` on the scripts, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test`):

- Test Files 1076 passed, 2 skipped (1078). Tests 8870 passed, 13 skipped (8883).
- Script tests: 288 passed, 0 failed, 1 skipped (289).
- `cargo test` library: 1366 passed, 0 failed, 2 ignored. The other crate suites in that run also reported 0 failed.
- The saved log of that run is cut off as the doc-tests start. `cargo test --doc` afterwards reported 0 passed across 2 suites, which is success (there are no doc-tests).

`npx vitest run src/features/plugins/model/desktopControl.test.ts` earlier in the round: 54 passed.

`cargo test --lib plugins::desktop_tests`: 20 passed.

## Not checked

- The live tarball was not downloaded. Tests use a fake archive and a download stand-in. They do not touch the network.
- `cargo clippy --target x86_64-pc-windows-gnu` was not run. That target is not installed here.
- `tests/browser/wp44-desktop.spec.ts` was not run. It needs the Vite server on port 1435, and WebKit is not installed. Browsers were not installed, and the daily app was not launched.
- The spike was not checked live.

On a Mac, the fetch itself still needs a look in a dev copy: Install desktop control, then Get the desktop program, then a consented headless command against the real binary. That is the one path that hits the registry. Do it in a dev slot, not the daily app.
