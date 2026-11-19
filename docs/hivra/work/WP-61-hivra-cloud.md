# WP-61: Hivra Cloud machine

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 60 | no |

## Goal

Adding a Hivra Cloud computer is one screen: sign in, pick a machine, and its projects appear in the rail like any
remote machine, with first mates running there around the clock.

## Why

Hivra Cloud is the managed always-on option (SPEC.md section 9). This package is the app side only; the service
that provides the machines is separate and out of scope here.

WP-133 is the design for a phone, a web client and how they reach a machine. It does not replace this package.
What stays: Cloud is optional, sign-in if it ever exists is a loopback flow, pairing does not send a long-lived
key, an account check fails soft and never blocks, and the app works with no Cloud account. What WP-133 adds:
the source of truth is the machine that holds the checkout (this desktop, or the WP-60 host on a computer that
stays up), and phone, web and a second desktop are views of it. They connect through the SSH host that already
exists, then a LAN or a tailnet the person runs, then an opt-in relay that cannot read the session. T3 Connect
is not the model. SPEC section 12 still defers a hosted multi-user relay, so neither package starts one.

## Read first

- WP-60; WP-133 (phone, web and reachability; design only); upstream's Add machine flow.
- OpenBot (MIT): loopback sign-in with PKCE from the desktop, the account check that is cached, fails soft and
  never blocks, routine safety rules (15-minute floor, stop after repeated failures, skip missed windows).
- Rerun (AGPL, ideas only): pairing a remote engine without the key travelling.
- Raven (Apache-2.0, ideas): a campaign ledger for unattended work (goal, budget, next check, ask the owner).

## Build

Built on 11 Nov 2026 as code, switched off. Ash's rule (10 Nov, 23:40): Cloud and teams stay off, nothing is
provisioned, no account is created, no domain is bought and nothing spends money. The endpoint is a placeholder and
is empty by default. Code: `src-tauri/src/hivra_cloud/` (`mod.rs`, `client.rs`, `routines.rs`).

1. **Connect Hivra Cloud** (built, off). The switch and endpoint live in `<data>/hivra-cloud.json`; the default is
   `enabled: false` with an empty endpoint. Settings reads and writes that file (`hivra_cloud_save`), and a stale
   revision changes nothing. A loopback sign-in (`sign_in_with`, reusing the PKCE, state check and code
   exchange in `connectors/oauth.rs`) gets an access token that stays in memory only. Pairing (`pair_with`) sends a
   one-time code, never a key, and returns the machine for the existing Add machine (SSH) path. The sign-in and
   machine-list screens, and the hand-off into Add machine, are in Settings (`src/features/hivraCloud/`). Connecting
   still happens in the existing SSH form.
2. **Account check** (built, off). `AccountCache`: an answer is kept six hours, a failed check waits fifteen minutes
   before it is tried again, and the failure notice shows once. The shown flag is kept in
   `<data>/hivra-cloud-notice.json`, which cannot turn Cloud on. The check never returns an error to the app, and the
   notice is shown in Settings.
3. **Routines** (built as pure rules, tested). `routines.rs`: a fifteen-minute floor, 24 runs a day, stop after three
   failures in a row (only the person resumes), and skip a missed window rather than catch up in a burst. Not built:
   the scheduler on the machine, which needs WP-60's host.
4. **Away feed** (built as a pure rule, tested). `routines.rs` `away_feed`: runs that finished while the person was
   away, newest first, filtered by what started them (person, schedule or first mate). Not built: WP-60 stamping each
   run with its starter, and the feed screen.
5. **Works with no account** (built and tested). With the switch off, no endpoint, or no token, no socket is opened.
   The tests count connections on a loopback listener to prove it.

Also built: the endpoint must be only an address (https, or http to this Mac, with no path, query or login); the
token is sent only to that endpoint; redirects are never followed and any non-2xx answer is a refusal; the pairing
code is checked before any request. Commands: `hivra_cloud_status`, `hivra_cloud_save`, `hivra_cloud_sign_in`,
`hivra_cloud_sign_out`, `hivra_cloud_account`, `hivra_cloud_pair`. Settings calls them. The switch stays off until
the person turns it on.

### Left for when Ash turns it on

- A staging service and its endpoint. Nothing here creates a server, an account or a domain; that needs Ash's go.
- WP-60's run stamps and the host scheduler, so routines and the away feed run on a machine that stays up.
- A native check in a dev copy with the switch on against a loopback stand-in, then against staging.

## Done when

- [x] Tests against a loopback stand-in: sign-in, pairing, account check failing soft, routine caps, away feed.
      The previous run of `cargo test --lib hivra_cloud` was 25 tests. This pass adds save, a stale revision,
      the notice file, and no socket on save. That command was not re-run, so the new count is not claimed.
- [ ] Browser spec `tests/browser/wp61-cloud.spec.ts` on Chromium and WebKit, and its screenshots. The spec is
      written. It was not run.
- [ ] `npm run check` passes; a dev-copy check against a staging service once one exists. Only some scoped checks
      were run for this package, and no staging service exists yet.

## See also

Phone basics (the Expo app already in `mobile/`, off by default, no store publish) are [WP-149](WP-149-mobile-app.md). A relay, a web client, and work that continues with the laptop closed are WP-133, which extends this package. WP-149 does not add a second remote plan and does not replace the decisions above.
