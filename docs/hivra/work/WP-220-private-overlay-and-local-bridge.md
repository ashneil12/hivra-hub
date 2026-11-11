# WP-220: Private networking that costs Hivra nothing (plan only)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O (private networking, plan only) | L | WP-133 (remote, phone and web design), WP-61, WP-203 (hard review) | no |

**This package is a plan.** It writes no product code, changes no firewall, and enrols no production machine. Nothing
in it is built until Ash okays this page. It touches remote access and phone access, so every PR that later builds
any part of it is security-sensitive: it needs a hard review by a different builder (WP-203) with no open high or
critical finding before it merges.

## Goal

Ash, 11 Nov 2026: Hivra should not pay for anyone's network. Anyone who launches a computer should be safe by default,
and connecting their own private network (Tailscale, Headscale, NetBird or plain WireGuard) should be easy and
optional. In practice:

1. **Safe by default, for free.** Every computer Hivra launches answers nothing on the public internet, cannot reach
   other people's computers, and cannot reach the owner's laptop or phone. This must cost Hivra nothing per user.
2. **Bring your own private network, in one step.** An owner who wants SSH from their laptop or phone pastes one key
   (Tailscale or Headscale today, NetBird and WireGuard later), and Hivra applies a safe policy for them.
3. **Reach a machine at home without opening ports.** Hosted Hivra never connects *into* a home network. The home
   machine connects *out*.
4. **Let a cloud agent run a command on the owner's own computer, only while the owner allows it.** The test case, a
   customer ask: "run `uname` on my Mac" from a cloud agent returns `Darwin` and exit code 0.

## What hosted Hivra already has (read 11 Nov 2026, `ashneil12/hivra` main at 07d3374)

Most of the free, safe-by-default part is already built. This plan finishes it rather than adding a new network.

| Piece | Where | State |
| --- | --- | --- |
| Hosted computers are VMs on a private NAT bridge behind each Proxmox host, with no public address of their own | `dashboard/src/lib/services/proxmox-instance-service.ts` (`PROXMOX_PRIVATE_SUBNET_PREFIX`) | live |
| Computers on the same host cannot reach each other (`table bridge hermes_vm_isolation`: tap-to-tap drops) | `dashboard/src/lib/services/proxmox/script-builders.ts` | live; checked before guest Docker access is enabled |
| Computers cannot reach the host, its SSH or the Proxmox UI; cannot reach private, CGNAT or link-local ranges over the WAN; the Proxmox UI accepts tailnet traffic only; host sshd is key-only | `dashboard/scripts/proxmox-host-perimeter-guard.sh` | audit by default, `--apply` at host standup |
| "Join my tailnet" on a computer's Manage page: the owner pastes a Tailscale auth key or a Headscale pre-auth key, with an optional Headscale server address; the guest runs `tailscale up --ssh=false --accept-routes=false --advertise-exit-node=false` | `components/hivra/HivraPrivateAccessPanel.tsx`, `app/api/hivra/agents/[id]/private-access/tailscale/route.ts`, `lib/hivra/tailscale-private-access.ts` | live on Ubuntu desktop computers |
| An outbound connector for home or office machines, and a relay that joins Hivra's SSH to it end to end (the relay cannot read the session; the pinned host key is checked every time) | `services/host-connector/`, `services/host-relay-worker/` (Cloudflare Worker, SQLite Durable Object) | built and tested, **not deployed**, not wired to the control plane |
| An older per-instance Tailscale endpoint | `app/api/instances/[id]/private-access/tailscale/route.ts` | no screen calls it; it still accepts `enableSsh` (Tailscale SSH) and free-form tags |

The gaps this plan closes:

- **The owner's tailnet decides what the computer can reach.** A new tailnet starts with an allow-all policy, so a
  computer joined to it can reach the owner's laptop and phone. Hivra tags nothing and tells the owner nothing.
- **No client version floor.** The guest installs whatever Tailscale's install script serves.
- **The home-machine path is built but switched off,** so the "Connect a machine on your network" screen still says
  hosted Hivra can't do it.
- **The legacy endpoint can still turn on Tailscale SSH.**

## What costs what

The rule: Hivra never runs a shared overlay network for everyone, and never pays per user for one.

| Option | Cost to Hivra | Cost to the owner | Notes |
| --- | --- | --- | --- |
| Hivra's own isolation (private bridge, nftables, host guard) | nothing beyond the servers Hivra already runs | nothing | Already the default. Every computer gets it. |
| Owner's own **Tailscale** tailnet | nothing | free on Tailscale's Personal plan for personal use (up to 6 users, 50 tagged devices); a business owner needs their own paid plan | Tailscale's client is BSD-3-Clause. Hivra stays out of the licence question because the tailnet is the owner's, not Hivra's. |
| Owner's own **Headscale** server | nothing | their own small server | BSD-3-Clause. Single tailnet per server by design; that is fine because it is the owner's. They also choose a DERP relay plan (Tailscale's public map or their own). |
| Owner's own **NetBird** (cloud or self-hosted) | nothing | free tier or their own server | Client mostly BSD-3-Clause; the server parts are AGPLv3. That only matters if Hivra hosts or ships the server, which it doesn't. |
| Plain **WireGuard** to the owner's devices | nothing (a forwarded UDP port per computer on the host) | nothing | No coordination server, no relay. Each computer is its own small hub for its owner's devices only. Later option, see below. |
| The home-machine **relay** (connector + Worker) | Cloudflare Workers; built to fit the free plan with SQLite Durable Objects. Check Cloudflare's daily limits before a large launch; past them, Cloudflare's paid Workers plan is a flat monthly fee, not per user | nothing | Carries SSH only, end to end. |
| Hivra running Headscale or NetBird **for everyone** | a control server, relay bandwidth, on-call, and Hivra holding the keys to every customer's network | nothing | **Rejected.** It is not free at scale, Headscale is built for one tailnet per server, and it makes Hivra the single place to attack. |

## The plan

### 1. Safe by default (every computer, free, automatic)

Nothing to switch on. What exists stays, plus:

- Run `proxmox-host-perimeter-guard.sh --check` on every host as part of the fleet health check, and alert when a host
  drifts from it. The isolation table and the guard are the real default; they must not silently go missing.
- A computer never gets a public SSH port. Hivra reaches it the way it does today; the owner reaches it through Hivra or
  through their own private network (step 2).
- Add a guest-side rule on computers that join a private network: the computer may answer connections that come in
  over `tailscale0` (or `wg0`), but may not start new ones to other tailnet devices. This is defence in depth only: a
  computer an attacker controls as root can remove it, which is why step 2 also writes the owner's tailnet policy.

### 2. Bring your own private network, in one step

Keep the existing panel and make it safe and obvious:

1. **One screen, four choices:** Tailscale, Headscale, NetBird, WireGuard. Tailscale and Headscale exist today. NetBird
   joins with its setup key the same way. WireGuard is the later option below. It works like connecting your own
   Composio account: the account is the owner's, Hivra only connects to it. **Switching** is one action on the same
   screen: pick another provider, paste its key, and Hivra leaves the old network and joins the new one, with the
   computer's own access through Hivra unaffected throughout.
2. **Hivra mints nothing and stores no long-lived key.** The owner makes the key in their own admin page; the panel
   says how: a one-off, pre-approved key with the tag `tag:hivra`. The key goes to the computer once, over the existing
   guest channel, and is never stored.
3. **Version floor.** After install the guest checks `tailscale version` and refuses to join below **1.104.4** (the
   release that fixed the October 2026 "Tailworm" findings in Tailscale SSH and Serve). Current stable at writing:
   1.104.6. NetBird gets its own floor when it is added.
4. **Always off:** Tailscale SSH, Funnel (it publishes to the public internet), exit nodes, subnet routes. The owner
   reaches the computer with normal OpenSSH over their private network, keys only. Retire the legacy
   `/api/instances/[id]/private-access/tailscale` endpoint, or make it refuse `enableSsh` and free-form tags.
5. **A ready-made policy, shown after the computer joins**, to paste into the owner's tailnet policy file. Deny by
   default, with tests so a bad edit is refused:
   - the owner's own devices may reach `tag:hivra` on TCP 22 only;
   - `tag:hivra` may not reach any device, including other `tag:hivra` computers;
   - tests: the owner's phone reaches a computer on 22; a computer cannot reach the owner's laptop or phone; a computer
     cannot reach another computer.
   Hivra checks what it can see from the computer (can it open a connection to another device on the tailnet?) and
   shows **"Your tailnet lets this computer reach your other devices"** with a one-click copy of the policy until it
   can't. Hivra does not take admin access to the owner's tailnet to write the policy itself.
6. If the owner uses Tailscale's hosted plan, the panel suggests **Tailnet Lock** (new devices must be signed by one of
   the owner's own devices).

### 3. A machine at home, with no ports opened

Wire up what is already built:

1. Deploy the relay Worker behind a flag that is off by default, Canary first.
2. "Connect a machine on your network" gives a one-command install of `hivra-connector` on that machine. It dials out
   to the relay; nothing on the home router changes.
3. When Hivra needs that machine it dials out to the relay too, with a 60-second single-use ticket. SSH runs end to
   end; the pinned host key is checked on every session; revoke stops the connector.
4. The screen copy changes from "Hosted Hivra cannot connect to your local network" to the connector steps, only when
   the flag is on.
5. `HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS` stays off on hosted. The control plane is never pointed at a home address.

An owner who already has Tailscale, Headscale or NetBird on that home machine can use that instead; the connector is
for people who have nothing.

### 4. A cloud agent running a command on your own computer

The computer must not reach the owner's laptop, yet the customer ask needs exactly that. The answer is a **bridge the
owner switches on**, not a network path, and it rides the same outbound connector as step 3, so it costs nothing extra:

1. The owner switches on "Let my cloud agents run commands on this Mac" in the Hub app (or a small CLI). The connector
   on the Mac opens one extra outbound channel to the relay. Nothing listens on the Mac.
2. It speaks one narrow protocol: `exec` with an argument list, a working folder inside an allowed folder, a time
   limit and an output cap. It returns stdout, stderr and the exit code. No interactive shell, port forwarding or file
   transfer in the first version.
3. Each request carries a short-lived ticket for one agent on one computer. The Mac shows the command and by default
   asks the owner to approve it; "allow this agent for the next hour" is the only shortcut. There is no "allow forever".
4. Every request is logged on the Mac: which computer, which agent, the command, the exit code, approved or denied.
5. **Revoke** is one switch. Quitting the app or closing the laptop has the same effect.

The test: with the bridge on and the owner approving, a hosted agent's `uname` returns `Darwin` and exit 0. With it off,
the request fails with "the bridge on your Mac is off", and nothing on the Mac is listening.

Owners who run their own tailnet can choose to run the same bridge as a tagged `tsnet` node (Tailscale's embeddable Go
library, which also works with Headscale) instead of through the relay. The same rules apply: one port, exec only,
approval, log, revoke, and the policy lets only that owner's `tag:hivra` computers reach it.

What this is not: not putting the Mac on a flat network, not "computers can SSH to the Mac", not Tailscale SSH, not
Funnel.

Phones are the same: a phone may reach computers; computers never reach the phone. The phone talks to agents through
the existing pairing (WP-150, WP-195a).

### 5. Later: plain WireGuard with no account anywhere

For owners who want no third party at all: the computer runs WireGuard as a small hub for that owner's own devices
only. The host forwards one UDP port per computer; WireGuard ignores any packet not signed by a known key, so the port
looks closed to scanners. The panel shows a QR code for the phone and a config file for the laptop. Free, no
coordination server, no relay, and isolation comes from the shape (each computer only knows its owner's devices). The
cost is convenience: one tunnel per computer. Build it only if owners ask.

### Owners' own servers and Hivra's fleet

For a server the owner adds (not a Hivra VM), the same choices apply. Closing its public ports is a separate, gated
step, because an agent that empties a firewall before the private path works locks the owner out:

1. Join the private network (step 2) or install the connector (step 3).
2. **Prove SSH works over it** from the owner's laptop and phone, with the public path still open.
3. The agent writes a firewall plan (rules to remove, rollback, the provider's console or rescue path) and **stops**.
   The owner presses Apply after reading it.
4. Prove from outside that 22, 80 and 443 are closed and SSH over the private path still works.

Public websites, if any, go through Cloudflare Tunnel (outbound only, free plan). Hivra's own Proxmox hosts follow the
same steps, done by a person, one host at a time.

## Pilot (after Ash okays this page)

On throwaway machines only: one new Hetzner Cloud VM created for the pilot and deleted after, a Canary computer made for
the pilot, and Ash's Mac. No customer computer, no production host.

1. Join the Canary computer to a tailnet with the step 2 policy and its tests; prove SSH from Mac and phone; prove the
   computer cannot reach the Mac, the phone or a second pilot computer.
2. Same with a Headscale server on the throwaway VM.
3. Deploy the relay to Canary behind its flag; enrol the throwaway VM with the connector as if it were at home; prove
   SSH through the relay and that revoke stops it.
4. Prototype the bridge on the Mac; prove `uname` returns `Darwin` and exit 0 with approval, and fails with it off.
5. Note the relay's usage against Cloudflare's free limits, and anything that changes this plan, on this page's PR.

## Build packages that follow (not started)

- **WP-220a** Private-network panel: version floor, `tag:hivra`, the ready-made policy and the "can reach your
  devices" check, NetBird, retire the legacy endpoint (hosted).
- **WP-220b** The guest-side outbound rule and the fleet check of the host guard (hosted).
- **WP-220c** Turn on the connector and relay for home machines, flag off by default (hosted).
- **WP-220d** The exec bridge on the owner's computer (Hub app and connector).
- **WP-220e** Plain WireGuard per computer (only if owners ask).

Each is Grok OK: no, ships behind a flag that is off by default, and needs the WP-203 hard review before merge.

## Done when

- [ ] Ash has read this page and okayed it, or said what to change.
- [ ] The pilot has run on throwaway machines, with the proofs attached.
- [ ] The build packages above have their own pages.

## Sources

- The late-October 2026 Hetzner hardening thread (Pieter Levels) and its replies: outbound tunnels, emptied firewall,
  per-box isolation, the lockout warning, and "write the plan first, a human applies it".
- Tailscale docs: how Tailscale works, DERP servers, ACLs and grants, tags, auth keys, `tsnet`, Serve, Funnel, Tailnet
  Lock, pricing (read 11 Nov 2026).
- Tailscale's "Tailscale SSH: findings and fixes" post and security bulletins from TS-2026-015; the independent
  tailworm.com report.
- Headscale (github.com/juanfont/headscale), NetBird (github.com/netbirdio/netbird), wireguard-go, cloudflared.
