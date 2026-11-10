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

### Phone

The inherited Expo app is the starting point, not a dead end. It already pairs with the desktop, shows chats, and does real work against the desktop's project. Starting a new phone app would throw that away. This package does not publish it, and it does not assume an App Store or Play Store listing.

What it is today. The app is still named MonoCode. The Expo owner is `hardbeat920`. The iOS bundle id is `com.hardbeat920.monocode-mobile` (`mobile/app.json`). A Hivra listing would need Ash's own accounts, a new bundle id and a new Expo owner. That is his decision, not a step in this package.

What already works, from the desktop's allow list in `src-tauri/src/mobile_access.rs` and the screens that call it. Read a chat, send, start, stop, rename, archive and delete a session. Answer an agent question (`session.answerQuestion`, `mobile/src/features/sessions/QuestionCard.tsx`). Resume after a usage limit. Read the file tree and a file, and search. Open the changes view, stage, and run the git action (`project.gitAction`), which is the commit and push path. Pick a model and a saved account. Dictate on the phone. `mobile/README.md` still says questions need the desktop. That sentence is stale. The question card answers them.

What stays off the phone for a first slice.

- Tool approvals. The transcript the phone shows says "Waiting for approval on desktop", and the allow list has no method that grants or denies one. This is the first gap to close if Ash says go, because the phone already tells him something is waiting and then cannot take the tap. Letting a phone allow a tool call is a security decision, and it stays his.
- A terminal. There is no terminal route and no terminal method. A shell on a phone is a large jump in trust, and remote-host projects do not have a terminal yet either. It stays on the desktop.
- Writing a file from the phone. The allow list can read a file. It cannot save one. Editing stays on the desktop until a later package has a reason and a review.
- Crew, tasks, decisions and the Inbox. None of those methods are in the allow list. They can follow. They are not the first slice.
- Push while the app is closed. The allow list has no push registration method. Do not promise a buzz in a pocket.

What ships first, if he says go, in this order: the chats and questions that already work, then approvals, with diffs as they already are. Files stay a reader. The terminal stays on the desktop.

How it connects. Pairing is a one-time code, QUIC with mutual TLS, and the desktop's identity is pinned by that code. The desktop must stay awake (`mobile/README.md`). Mobile access itself defaults to off (`enabled: false` in `src-tauri/src/mobile_access.rs`). Dev copies refuse phone access (`phone_access` in `src-tauri/src/instance.rs`). The router-mapping flag defaults to on, but it only acts after mobile access is turned on. This package does not change that default. Widening it, or turning mapping on for anyone who has not asked, is out. Changing the default so mapping stays off until a separate tap would be a behaviour change on upstream mobile code, which SPEC section 11 says not to touch. That change is an Ash decision, not a silent edit.

The phone cannot reach the SSH host. Closing the laptop ends the peer the phone knows. A later package that wants the phone while the laptop is shut has to teach the host to speak the phone's protocol, or teach the phone to be a client of the host. That is the large piece. It is not started here. SPEC section 11 still says the mobile app is kept, so that later package is a small hook, not a rewrite.

### Web

There is no separate web client in this repo. The desktop UI is the Tauri webview. `docs/remote-access.md` already allows a person to put their own HTTPS reverse proxy in front of the loopback host, and it accepts plain HTTP only for a loopback address. The credential stays in the native app. It is not put in browser storage.

Recommend a local client, not a signed-in hosted site.

A local client means a page the desktop or the host serves, on loopback, or on a LAN or tailnet address the person has already chosen to open. No account. The same device credential the host already issues is enough. It defaults to off, or to loopback only, until that person turns a wider address on. This matches the host that already exists, and it does not need a domain or a certificate from a public authority. A tailnet HTTPS name, if the person uses one, is their network's certificate, not Hivra's.

A signed-in hosted site, the shape of `https://app.t3.codes`, is the wrong first client. T3's own docs say that page needs HTTPS, connects to the server directly, and does not make an unreachable machine reachable. Browsers block plain HTTP from an HTTPS page, which is why their hosted app stays on T3 Connect. Running the same shape means Hivra operates a website, a domain, a certificate and an account directory. That is a public service. SPEC section 12 still defers it. This package does not start it.

If Ash later wants a hosted page, it is still only a view of a host he can already reach. It uses the device credential the host already has. It does not grow a user database, and it does not use Clerk or any other third-party account kit. Their user docs do not name Clerk. The refusal is so a later package does not add one to fill the gap.

No implementation of either client is in this package.

4. The laptop can close only when some other machine is the host. Keep-awake does not do that. No vendor price is quoted, because those pages were not opened.

5. Domain, certificates, Apple and Google developer accounts, hosting, and whether any account exists at all are Ash's. This note lists them. It does not choose them, and it does not build them.

## Done when

- [x] WP-61 is updated or explicitly cross-linked, not forked in silence.
- [x] A recommended relay model is written, with T3 Connect rejected as a copy target.
- [ ] Ash's open decisions are listed.
- [ ] No product code, no relay server, no store listing work.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source file is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
