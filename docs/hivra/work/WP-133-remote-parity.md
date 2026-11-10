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

### Architecture

Three roles.

The source of truth is the machine that holds the checkout and runs the agents. For a project on this computer, that is the desktop. For a project opened on another machine, that is the host. `docs/remote-access.md` already says the host owns the provider processes and the session database, and that closing the desktop does not stop a host session. A client does not keep a second copy of that truth.

A background host is that same host package, on a machine that stays up. It binds to loopback only. The desktop reaches it through an SSH forward. On Linux the user service can survive logout. On macOS the Mac has to stay logged in and awake. On Windows the desktop session has to stay signed in and awake. A host on the laptop dies when the laptop sleeps. A host on another machine does not.

A client is a thin view: the phone, a web page, or a second desktop. It sends commands and shows results. It does not run the agents. When the desktop is only driving a remote host, it is already that kind of client for sessions. The phone is not. It talks to the desktop process, not to the host (`mobile/README.md`).

Four ways to reach the host.

SSH only is what ships. Add machine uses the person's own SSH. The forward is loopback on the laptop. There is no Hivra account, no public listener and no relay. This stays the default and the trust floor. It is not enough on its own for a phone somewhere else, or for a browser, unless the person already has a path to that machine. Remote projects also still have no terminal, as that same doc says.

A LAN, or a tailnet the person runs (Tailscale, or any VPN they already use). T3 documents both, and a new T3 service answers only on that machine until local-network access is turned on. Hivra should support this path and should not operate the network. No account, no machine cap, no relay bill. It asks every person to bring a network, so it cannot be the only future path. It also cannot be dropped. Anything that listens beyond loopback stays off until the person turns it on. The host today does not listen beyond loopback at all.

An opt-in untrusted relay, with no account required to use the app. "Paseo-style" in this note means the properties, not a copy of a product whose pages were not re-fetched: the relay cannot read the session, the app works with no account, the relay is off until that machine's owner turns it on, and there is no cap tied to a chat plan. Pairing stays a one-time code, as the phone and the SSH host already do, not a user directory. Nothing read for this note is a concrete reason to reject that list. The concrete reason not to run it now is SPEC section 12: a hosted multi-user relay is not now. An untrusted relay is still a public service. Someone pays for it, someone answers abuse, and it still shows metadata (who is online, when, and how much). This package writes the properties. It does not deploy a relay.

T3 Connect is rejected as a copy. It needs their account. A free account links 3 machines, Pro links 10, Premier links 100, and phones and browsers do not count. Their own FAQ says it keeps disconnecting, and treats Tailscale as the fallback. Their FAQ also says the relay only sets up a Cloudflare tunnel and does not proxy the session. Even if that is true, the account, the cap and the disconnects are enough. Do not copy the tunnel, the telemetry, the hosted site, or the name. Their user docs do not name Clerk. Do not add a third-party account kit anyway.

If Ash later says go, the order is: keep SSH and loopback as the default, add a LAN or a user-run tailnet only when the person turns it on, and leave the untrusted relay as a written target rather than a server.

SPEC section 11 says the upstream remote host and the mobile app are kept and not rewritten. A later package adds a small hook. It does not fork those trees. WP-60 still owns the part this note does not: first-mate records and the watcher have to run on the host, or a closed laptop that was the desktop still loses the crew even when the host keeps the provider session.

The other four decisions:

2. The inherited Expo app is the starting point, not a dead end, and this package does not publish it. If Ash later says go, the first slice is chats (already there), approvals (not there) and diffs (already there). A terminal stays on the desktop. Files stay read-only until a later package.

3. The web client is a page served by the desktop or the host, on an address the person can already reach. It is not a signed-in website Hivra operates. No Clerk, and no other third-party account kit.

4. The laptop can close only when some other machine is the host. Keep-awake does not do that. No vendor price is quoted, because those pages were not opened.

5. Domain, certificates, Apple and Google developer accounts, hosting, and whether any account exists at all are Ash's. This note lists them. It does not choose them, and it does not build them.

## Done when

- [x] WP-61 is updated or explicitly cross-linked, not forked in silence.
- [x] A recommended relay model is written, with T3 Connect rejected as a copy target.
- [ ] Ash's open decisions are listed.
- [ ] No product code, no relay server, no store listing work.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source file is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
