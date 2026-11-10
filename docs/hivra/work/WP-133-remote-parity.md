# WP-133: Remote, phone and web (design only)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | L | WP-61 | no |

This package is design only. It does not write product code. Grok OK: no. It extends WP-61 and does not start a second plan. An earlier decision is changed only where this note says so.

## Goal

One design Ash can accept or reject: a background host, a phone, a web client, and a way to reach them that does not copy T3 Connect. The laptop may close when the host is some other machine. The desktop, or that host, stays the source of truth. Clients are thin views.

## Why

Remote access (18 voices) and a phone app people actually use (14 voices) are the two T3 differences that came up most in the 6 Nov survey. Hivra already has an experimental SSH host (`docs/remote-access.md`) and an inherited Expo app (`mobile/`). The phone talks to the desktop, and the desktop has to stay awake (`mobile/README.md`). Ash has not said go.

T3's user docs, cited at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`, are the behaviour this note answers. The pages were read from a later checkout (`6577c6b6`), so a sentence below may be newer than the pin. The pin is the citation. Where the two could differ, trust the file at the pin.

From those pages:

- The machine that runs the agents has to stay running and reachable. A phone is a remote. It does not do the work.
- T3 Connect needs a sign-in. A free account links 3 machines. Linking T3 Chat Pro raises that to 10, and Premier to 100. Phones and browsers do not count.
- The FAQ says T3 Connect keeps disconnecting, and points at Tailscale as the fallback the author uses.
- The FAQ says traffic rides a Cloudflare tunnel, the relay sets the link up, and it does not proxy the HTTP or WebSocket session. Code goes to the provider, not to T3. That claim is theirs. It is not a reason to copy the product.
- The hosted web app is `https://app.t3.codes`. It needs HTTPS. It connects to the server directly and does not make an unreachable machine reachable. Browsers block plain HTTP from that HTTPS page, so the hosted app stays on T3 Connect.
- On Linux and macOS, `t3 up` can install a background service. Linux uses systemd user lingering so it survives logout. macOS starts the service at login and stops it at logout, and the Mac has to stay logged in and awake. Windows has no background service.
- A new service answers only on that machine until local-network access is turned on. LAN, Tailscale and SSH are documented paths next to T3 Connect.

Paseo's security and connectivity pages, Orca's site, and the public price pages were not opened while this note was written. Nothing below invents a price, a licence, or a claim about those products' current code.

## Read first

- WP-60 and WP-61. SPEC.md sections 9 and 12. Section 11 says the upstream remote host and the mobile app stay as they are.
- `docs/remote-access.md`, `mobile/README.md`, `mobile/app.json`, `src-tauri/src/mobile_access.rs`, `src-tauri/src/autopilot.rs`.
- T3 user docs at the commit above: `docs/user/remote-access.md`, `docs/user/background-service.md`, `docs/user/faq.md`. Ideas only. Do not copy their relay.
- Paseo: `https://paseo.sh/docs/security` and `https://paseo.sh/docs/connectivity`. Not re-fetched here.
- Orca: `https://www.onorca.dev/`. Not re-fetched here. Vendor cloud sessions (Cursor, Claude, Codex) are WP-136, not this package.

## Design

The five decisions. Later notes in this file spell out the comparison. The recommendation itself is here.

1. Local-first stays. The source of truth is the machine that holds the checkout and runs the agents: this desktop, or a background host on a machine that stays up. Phone, web and a second desktop are thin views. Reachability order: loopback and the SSH host that already exists, then a LAN or a tailnet the person runs, then an opt-in relay that cannot read the session and does not need an account. T3 Connect is not the model to copy. There is no concrete reason here to reject that relay model. There is a concrete reason not to run one yet: SPEC section 12 still says a hosted multi-user relay is not now, and this package does not start one.

2. The inherited Expo app is the starting point, not a dead end, and this package does not publish it. If Ash later says go, the first slice is chats (already there), approvals (not there) and diffs (already there). A terminal stays on the desktop. Files stay read-only until a later package.

3. The web client is a page served by the desktop or the host, on an address the person can already reach. It is not a signed-in website Hivra operates. No Clerk, and no other third-party account kit.

4. The laptop can close only when some other machine is the host. Keep-awake does not do that. No vendor price is quoted, because those pages were not opened.

5. Domain, certificates, Apple and Google developer accounts, hosting, and whether any account exists at all are Ash's. This note lists them. It does not choose them, and it does not build them.

## Done when

- [ ] WP-61 is updated or explicitly cross-linked, not forked in silence.
- [ ] A recommended relay model is written, with T3 Connect rejected as a copy target.
- [ ] Ash's open decisions are listed.
- [ ] No product code, no relay server, no store listing work.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source file is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
