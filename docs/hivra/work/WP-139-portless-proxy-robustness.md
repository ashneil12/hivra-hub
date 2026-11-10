# WP-139: Portless 0.17 proxy robustness

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | S | none (WP-90 already landed) | yes |

## Goal

The local name proxy retries a transient Windows lock error instead of failing the name list, and it dials IPv4 and IPv6 loopback in parallel so a hung v4 attempt no longer waits out a five-second timer before trying `::1`. TLS, HTTPS aliases, Docker Compose and hosts-file sync stay out.

## Why

Hivra's proxy is a line-by-line Rust translation of vercel-labs/portless (Apache-2.0, Copyright 2025 Vercel Inc.) from WP-90. A 9 Nov 2026 quality pass compared `origin/main` with portless 0.17.0 (commit `1d2dbbc`, changelog dated for that release).

Two 0.17 bug fixes are better than what Hivra ships:

1. **Parallel loopback dial.** Portless `packages/portless/src/utils.ts` `createLoopbackConnection` races `127.0.0.1` and `::1` and keeps the first socket that connects, with no fallback timer. Failed attempts are listed in the error (proxy.ts also documents this). Hivra `src-tauri/src/proxy/server.rs` `connect_upstream` tries IPv4 with `CONNECT_TIMEOUT` (5s) and only then IPv6, so a stalling v4 connect delays a healthy `::1` backend by up to five seconds, and a total failure can take ten. Adopt the race, and when both fail, say each address and its error.

2. **Windows route-lock `EPERM`.** Portless `packages/portless/src/routes.ts` `acquireLock` retries `EPERM` on Windows instead of giving up with "Failed to acquire route lock" (#553). Hivra `src-tauri/src/proxy/routes.rs` `acquire_lock` returns immediately on any `create_dir` error that is not `AlreadyExists` ("The name list is busy, so nothing changed: {error}"). On Windows a transient `PermissionDenied` / `EPERM` (indexer, antivirus) can fail a name add or removal that would have succeeded a moment later. Retry those the same way as a live lock, up to the existing `LOCK_TIMEOUT`.

Do not port 0.17's new features: HTTPS alias backends (`--upstream`), worktree hostname templates, alias TLD selection, or 0.16 Docker Compose. WP-90 left TLS and hosts-file sync out on purpose.

## Read first

- Portless 0.17.0, read-only: `packages/portless/src/utils.ts` (`createLoopbackConnection`), `packages/portless/src/routes.ts` (`acquireLock`), `CHANGELOG.md` (0.17.0 Bug Fixes, #545 and #553). A shallow clone is enough; delete it after reading.
- Hivra `origin/main`: `src-tauri/src/proxy/server.rs` (`connect_upstream`, `CONNECT_TIMEOUT`), `src-tauri/src/proxy/routes.rs` (`acquire_lock`, `LOCK_TIMEOUT`, `LOCK_RETRY_BASE`, `LOCK_RETRY_CAP`), and the existing `#[cfg(test)]` modules in those files.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-139-portless-proxy-robustness.md`. In `docs/hivra/SOURCES.md` and the existing portless credits.json / NOTICE entries, note that the 0.17 lock and loopback fixes were translated in this package (keep the original WP-90 credit; do not invent a second copyright line). `npx vitest run src/features/settings/model/credits.test.ts` if those files change.
2. **Parallel loopback.** Change `connect_upstream` so IPv4 and IPv6 start together and the first successful `TcpStream` wins; cancel or drop the other. Do not wait for `CONNECT_TIMEOUT` on the first family before starting the second. If both fail, the 502 (or existing error path) must name each address and its error, in the spirit of portless #545. Tests: a v6-only backend is reached without waiting the v4 timeout; a failure message mentions both `127.0.0.1` and `::1` when both are tried; a v4-only backend still works. Keep the proxy loopback-only.
3. **Windows lock retry.** In `acquire_lock`, on Windows, treat a transient `PermissionDenied` (and raw `EPERM` if that is how it appears) as retryable, with the same backoff as `AlreadyExists` / a live lock, until `LOCK_TIMEOUT`. Other errors still fail at once. A non-Windows `PermissionDenied` that is not "already exists" stays a hard failure (do not widen Unix behaviour). Add a test that a simulated Windows `EPERM` is retried and then succeeds.
4. **Out of scope.** No TLS, no `--upstream`, no compose, no hosts file, no sudo, no change to hostname or label rules.

## Copy with credit

- Source: vercel-labs/portless 0.17.0 (`1d2dbbc`), Apache-2.0, "Copyright 2025 Vercel Inc."
- Files to credit: `packages/portless/src/utils.ts` (`createLoopbackConnection`) and `packages/portless/src/routes.ts` (`acquireLock`).
- Keep the existing SPDX headers on `src-tauri/src/proxy/*.rs`. Mention WP-139 and 0.17.0 in the comment that already names the translation.

## Done when

- [ ] `connect_upstream` races loopback families; tests cover v4-only, v6-only, and a dual failure message.
- [ ] Windows route-lock `EPERM` / `PermissionDenied` is retried up to the existing timeout; a test pins that.
- [ ] Credits / SOURCES / NOTICE updated only as needed; `credits.test.ts` green if they changed.
- [ ] No TLS, compose, or hosts-file work in the diff.
