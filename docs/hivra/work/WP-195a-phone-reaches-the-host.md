# WP-195a: The phone keeps working when the laptop is closed

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| phone app, last | L | 133 (its design), 150, 60 | no |

From PLAN.md, "From Aether", item 3 (watching and steering from the phone). Ash wants the phone app built last.
Reviewing pull requests and a worker's terminal on the phone are [WP-195b](WP-195b-phone-pull-request-review.md);
reply by email is not planned (see the end). Aether is closed source: ideas only, nothing credited.

## Goal

For a project that lives on an added host, the paired phone talks to that host directly, so the person can watch,
send, answer questions and approve while the laptop is closed. A project on the laptop still needs the laptop.

## What Hivra has

- The phone app (`mobile/`, WP-149, WP-151) pairs with the desktop by a one-time code over QUIC with mutual TLS
  (`crates/mobile-link`, `src-tauri/src/mobile_access.rs`). The desktop's allow list answers `conversation.*`,
  `session.*` (including `session.approve` and `session.deny` from WP-150), `inbox.list`, `crew.status`, `project.*`.
  Mobile access is off by default, refused in dev copies (`phone_access` in `instance.rs`).
- The host (`host/server.ts`) owns provider sessions and, for remote projects, the first mate records (WP-60). Its
  device credentials are issued per device and it listens on loopback only.
- WP-133 (design, accepted as the plan): the source of truth is the machine that holds the checkout; reach it over
  SSH, then a LAN or a tailnet the person runs; no relay is operated; a phone gets no shortcut past an approval.

## What to build

1. **Pair a phone with a host.** From the desktop's Machines page (WP-181a) or Settings > Mobile: "Let my phone reach
   build-box directly". The desktop, already connected over SSH, asks the host for a one-time pairing code; the host
   shows its address choices limited to what the person typed (a LAN or tailnet address); the phone scans it. The host
   issues the phone its own device credential. No long-lived key crosses the desktop.
2. **A phone endpoint on the host** (`host/mobile/`, new), off until that pairing: it binds only the address the
   person chose (never `0.0.0.0` unless they type it, with a warning), and serves the same method names as the
   desktop's allow list for the host's own projects, so the phone code paths stay the same. Methods the host cannot
   answer return the typed "not on this machine" error.
3. **Same approvals.** `session.approve` and `session.deny` on the host go through the same approval records as a
   desktop tap; a phone gets no auto-allow, no skipped prompt. The host's approval card and the desktop's (when it
   reconnects) show the same decision once.
4. **The phone picks its peer.** The app keeps a list of peers (desktop, hosts). A chat on a host project talks to the
   host when it is reachable, else to the desktop. The peer is shown in the chat header.
5. **Revoke** from the desktop or the host removes the phone's credential on that host before the next call.

## Rules

- Off by default per host; refused in dev copies and under a temporary HOME. No router mapping, relay or account.
- The host listens only where the person chose. Loopback-only stays the host default.
- Never weakens an approval or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists):
  every remote action meets WP-133's rule that a phone has no shortcut.
- Upstream rules from PLAN.md: `mobile/` and `crates/mobile-link` are upstream code; changes are small hooks, the host
  side is new code.

## Done when

- [ ] Red first: a host test asks `inbox.list` as a paired phone and fails before the endpoint exists.
- [ ] Tests: an unpaired, revoked or expired device is refused with an error, never an empty list; an approval from
      the phone lands in the same record as a desktop one; the endpoint binds only the chosen address.
- [ ] Phone tests (`mobile/tests/`): peer choice when the host is reachable and when it is not; the header line.
- [ ] Browser spec `tests/browser/phone-host-pairing.spec.ts`: the desktop's pairing screen for a host, the address
      warning, revoke. Screenshot in the PR.
- [ ] `npm run check` passes. A Simulator check against a real host with the laptop's app quit stays open until done.

## Not in this package

Pull request review and the terminal view (WP-195b). Store listings. A relay or hosted web client (SPEC section 12).
**Reply by email that resumes a run** is left out: it needs a mail service or inbox access Hivra does not have, and an
email reply would be a way around the approval rule; it can come back as its own decision.
