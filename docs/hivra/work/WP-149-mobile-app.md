# WP-149: Phone app, private build and test only

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Mobile (last before WP-92) | S | phone-base report; [WP-133](#remote-sleep-and-cloud-stay-where-they-are); [WP-61](WP-61-hivra-cloud.md) | yes |

This package is the design. It does not change product code, open a listener, rename the app, or publish anything.

## Goal

Use the Expo phone app already in this fork (`mobile/`). Keep mobile access off by default. Prove it on the iOS Simulator. Do not publish to the App Store or Play Store in this programme.

The laptop stays awake for this version. A host that keeps working with the laptop closed, a relay, and a web client are not decided here. They stay with WP-133, which extends [WP-61](WP-61-hivra-cloud.md). This page does not start a second remote plan.

## Recommendation

Do not start a Tauri 2 mobile app, a new React Native app, or a PWA. The inherited app already pairs with the desktop, streams a transcript, starts a session and stops a turn (`mobile/README.md`).

The person turns Mobile on in desktop Settings, scans one QR code, and the phone talks to that desktop over the existing QUIC link (mutual TLS, fingerprints pinned by the code). A first phone build shows what that app already shows, plus, once a later package adds the desktop methods, Inbox (waiting on the person), crew status, chat with the first mate, and approvals.

Mobile access stays off until that Settings switch is on. The listener stays behind the instance `phone_access` policy as well (see [Security](#security)).

## Why not the alternatives

| Option | Verdict |
| --- | --- |
| Inherited Expo app in `mobile/` | **Chosen.** Pairing, transcripts, new sessions and stopping a turn are already there. |
| Tauri 2 mobile | Same Rust desktop stack, but a weaker phone story than the Expo app already in the tree. |
| A new Expo or React Native app | Throws away the inherited app. |
| PWA only | No SecureStore and no native QUIC module. Expo Go cannot load `monocode-link`. |
| T3-style Connect, or a Clerk relay | Not a copy target. WP-133 owns that choice. Prefer the LAN, Tailscale, or a later untrusted opt-in relay. This page does not design the relay. |

## How pairing works today

`mobile/README.md` and `src-tauri/src/mobile_access.rs` already do this. Later packages reuse it. They do not replace it.

1. Desktop: Settings → Mobile → turn mobile access on → Pair device → QR.
2. Phone: scan the QR. A code lasts 15 minutes and works once.
3. Choose which projects and Monos appear. The choice is remembered per desktop, including after a reconnect. Choosing nothing and deciding later is allowed.
4. Revoke a device from desktop Settings. Long-lived private keys stay in the desktop OS keyring and the phone's SecureStore.
5. The phone connects to the desktop directly. Prefer the LAN or Tailscale. Router UPnP stays a conscious choice: `open_router` already defaults to true in `Config::default`, and NAT-PMP/UPnP mapping starts when mobile access is enabled with that flag on. Later packages must not turn mapping on in more cases, and must not drop the Settings control or the security note. A restrictive router can need a reachable VPN address or a manual UDP forward to port 38416.

The desktop must be running and awake. Closing the laptop is out of scope here.

What the inherited app already does, from `mobile/README.md`: workspace lists while the phone is active; the latest 200 user and assistant blocks of a conversation; live updates; sending text; starting a session; stopping a turn; Git changes on demand; switching a Claude Code or Codex account that was saved on the desktop; usage windows. It keeps the workspace list for offline navigation and keeps a draft if a send fails. It does not queue commands offline. Agent approvals and questions still need the desktop.

## What a later package adds

Not this page, and not already in the app:

- Waiting on the person: Inbox rows, approvals, and agent questions. These need small desktop API additions (WP-150).
- Crew status, once the [WP-119](WP-119-crew-tree-inbox.md) tree is available to merge into the phone UI.
- A Hivra name, bundle ids, icons and strings on the inherited app (WP-151). No store listing.

## Remote, sleep and cloud stay where they are

Three different "remote" ideas already exist. This page uses only the phone link.

| Idea | Where it lives | What this page does with it |
| --- | --- | --- |
| Phone paired to a desktop that stays awake | This page, on the inherited QUIC link | The v1 path |
| Hivra Cloud: sign in, pick a machine, first mates run there | [WP-61](WP-61-hivra-cloud.md), SPEC.md section 9 | Not restated. No second cloud design |
| Background host, web client, relay, laptop allowed to sleep | WP-133 (remote, phone and web). It extends WP-61 and rejects T3 Connect as a copy target | Not restated. No relay, no domain, no account model |

WP-133 is not in this tree yet. When that design lands it should link back here. Until then, laptop-closed and any relay stay parked with WP-133 and WP-61, not copied into a phone package.

## Security

Opening a network listener, pairing a device, pushing a token, or approving from the phone is security-sensitive. Build it, then a second person reviews it, then it waits for Ash. It does not merge on a docs review alone.

Facts a later package has to keep:

- Mobile access is off unless Settings turns it on (`Config.enabled` defaults to false).
- Even then, a dev copy never opens phone access. `Kind::policy` sets `phone_access` only for the daily app. A copy under a temporary home turns it off again. `mobile_configure` returns "Phone access is off in a dev copy." and `init` will not bind port 38416 or start UPnP from a copied setting (`src-tauri/src/instance.rs`, `src-tauri/src/mobile_access.rs`).
- The daily app is the wrong place to prove this. A simulator run against the installed daily app is out of bounds.
- Those two rules conflict with "pair a dev copy". WP-150 has to resolve that without turning the daily listener on and without giving every dev copy phone access by default. That change is parked. This page does not make it.

## How to test

- **iOS Simulator.** From `mobile/`, `npm ci` then `npm run ios`, as `mobile/README.md` describes. That builds the Rust link, installs a development client, and starts Metro. It needs Xcode and an iOS Simulator runtime. No particular simulator model is required.
- **Android** is not part of this programme. Do not install Android Studio, the SDK, or an emulator as a side effect of the phone work.
- **End to end** is WP-152: a non-daily copy, Mobile turned on only after the `phone_access` question above is decided, one QR scan, Inbox or waiting-on-the-person, and one approval. Screenshots and the checklist belong in that package. Not here.
- No App Store, Play Store, or public EAS production profile. An internal ad-hoc or TestFlight install, later, is a separate decision. It is not this programme.

## Package split

Queued last, before WP-92.

| WP | Step | Grok OK | Security |
| --- | --- | --- | --- |
| 149 | This design, cross-linked to WP-133 and WP-61 | yes | n/a (docs) |
| 150 | Desktop pairing and API, still off by default: Inbox, crew and approval methods. Includes the dev-copy `phone_access` question | no | park |
| 151 | App shell: Hivra name, ids, icons and strings on the inherited Expo app; a simulator run | yes for the rename; a pairing test parks | rename yes; store publish never |
| 152 | End-to-end checklist on the iOS Simulator against a non-daily copy | no for a live listener | park |

Depends on the 6 Nov phone-base read of `mobile/`, on WP-133 for anything beyond a desktop that stays awake, on WP-119 when the crew tree is merged into the phone UI, and on WP-61 for a later always-on host.

## Sources

`mobile/` is already part of the MonoCode fork. [SOURCES.md](../SOURCES.md) credits [MonoCode](https://github.com/hardbeat920/monocode) (MIT) once, for the whole fork, packages "all". `credits.json` already has that line. No new licence line, no new NOTICE entry, and no new `credits.json` component.

## Done when

- [x] Design doc on the branch; cross-links to WP-61 and WP-133 present. WP-133 is named and not copied; WP-61 links back.
- [x] No listener and no app rename. Those are WP-150 and WP-151.
