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

1. **Connect Hivra Cloud**: a loopback sign-in from the app, then a machine list; choosing one pairs it without
   sending a long-lived key over the wire, and it is added through upstream's Add machine path.
2. **Account check**: read what the account allows, cache it, never block the app on it, never nag twice.
3. **Routines on the machine** follow the safety rules above.
4. **Away feed**: what ran while the person was away, filtered by what started it.
5. Everything works with no Hivra Cloud account: the option is there, never required.

## Done when

- [ ] Tests against a stubbed cloud service: sign-in, pairing, account check failing soft, routine caps, away feed.
- [ ] `npm run check` passes; a dev-copy check against a staging service once one exists.

## See also

Phone basics (the Expo app already in `mobile/`, off by default, no store publish) are [WP-149](WP-149-mobile-app.md). A relay, a web client, and work that continues with the laptop closed are WP-133, which extends this package. WP-149 does not add a second remote plan and does not replace the decisions above.
