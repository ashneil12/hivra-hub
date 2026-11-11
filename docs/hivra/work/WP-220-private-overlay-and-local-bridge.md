# WP-220: A private network for Hivra boxes, and a bridge to your own computer (plan only)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O (private networking, plan only) | L | WP-133 (remote, phone and web design), WP-61, WP-203 (hard review) | no |

**This package is a plan.** It writes no product code, changes no firewall, and enrols no production machine. Nothing
in it is built until Ash okays this page. It touches remote access and phone access, so every PR that later builds
any part of it is security-sensitive: it needs a hard review by a different builder (WP-203) with no open high or
critical finding before it merges.

## Goal

Two things, designed together because they pull in opposite directions:

1. **Every Hivra box sits on a private overlay network** and answers nothing on the public internet. The owner reaches
   it over SSH through the overlay, from a laptop or a phone. A box cannot reach other boxes, and cannot reach the
   owner's laptop or phone.
2. **A hosted agent can still reach the owner's own computer when the owner says so.** The test case, a customer ask:
   "run `uname` on my Mac" from a cloud agent returns `Darwin` and exit code 0. That works only while the owner has a
   bridge switched on, the owner can switch it off at any time, and it never turns the overlay into a flat network.

It also answers the question on the hosted app's "Connect a machine on your network" screen, which today says hosted
Hivra cannot reach a home network. Section 6 is the plan for changing that safely.

## Why

- The usual way a VPS gets broken into is an open port (SSH, the site, a forgotten admin panel). Agents now find these
  faster than people patch them, so keys alone are not enough.
- A widely shared Hetzner hardening recipe (late October 2026, Pieter Levels, repeated in many replies) fixes this with
  outbound-only tunnels: a private overlay for admin access, Cloudflare Tunnel for public web traffic, and the cloud
  firewall emptied so nothing inbound is allowed. It is Hivra's exact shape: boxes on Hetzner, an owner on a Mac and a
  phone.
- The same threads carry two warnings this plan must not skip. First, a fresh tailnet is a flat network: install the
  client everywhere and a broken box can reach every other box and the owner's devices. Second, an agent that empties
  the firewall before the overlay works locks the owner out of their own server.
- The October 2026 "Tailworm" report found eleven issues in Tailscale SSH, Serve, the DERP client and Headscale. All
  needed an attacker already inside the tailnet with Tailscale SSH or Serve allowed by policy. Tailscale fixed them in
  client v1.104.4. The lesson is about policy, not panic: least-privilege access rules are what stop "inside the
  tailnet" from meaning "inside every machine".

## What Hivra already has (read first)

- **WP-133** (design, accepted): the machine that holds the work is the source of truth; reach it over SSH, then a LAN
  or a tailnet the person runs, then an opt-in relay that cannot read the session. Anything that listens beyond
  loopback stays off until the person turns it on. This package keeps all of that and adds the box side.
- **WP-149, WP-150, WP-195a**: the phone pairs by one-time code over QUIC with mutual TLS, and prefers the LAN or
  Tailscale. `open_router` (UPnP) stays a conscious choice. Nothing here widens it.
- **Hosted Hivra already joins a computer to the owner's own tailnet** (the private-access panel on an agent's Manage
  page). The owner pastes their own auth key; the guest runs `tailscale up --ssh=false --accept-routes=false
  --advertise-exit-node=false`; the public view always reports `sshEnabled: false`. Good defaults. Two gaps: the client
  is installed from Tailscale's install script with no version floor, and whatever the box can reach is decided by the
  owner's own tailnet policy, which is often still the allow-all starter policy.
- **Hosted Hivra refuses private addresses** when it connects to a server (`HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS` is off
  on hosted). That is correct and stays: the control plane must never be pointed at someone's home network.
- **WP-203**: the structured hard review this package's build PRs must pass.

## 1. The Hetzner pattern (outbound-only)

Every box ends up like this:

| Traffic | Path | Inbound port on the box |
| --- | --- | --- |
| Owner's SSH and admin | OpenSSH over the overlay, keys only | none on the public interface |
| Public web (if a box serves a site) | Cloudflare Tunnel (`cloudflared`, outbound) with Cloudflare's WAF in front | none |
| Overlay itself | Outbound to the control plane and peers; DERP relay if no direct path | none |
| Updates, model APIs, git | Outbound as today | none |

The Hetzner Cloud firewall attached to the box has **no inbound rules** (Hetzner drops everything inbound when a
firewall has no inbound rules). Robot (dedicated) servers get the equivalent Robot firewall rule set.

### The lockout rule

The order is fixed, and an agent never runs it end to end on its own:

1. Install the overlay client and join the box (tagged, see section 2).
2. **Prove SSH over the overlay** from the owner's Mac and from the phone, with the public SSH path still open as a
   fallback. Record the proof (the overlay address used, `ssh -o BatchMode=yes box-overlay true` exit 0).
3. If the box serves public HTTP(S), bring up Cloudflare Tunnel and prove the site works through it.
4. The agent **writes a firewall plan** (current rules, rules to remove, the rollback command, the Hetzner console or
   rescue-mode path if it goes wrong) and **stops**. A human reads it and applies it, or explicitly tells the agent to
   apply that exact plan.
5. After the change, prove from a network that is **not** on the overlay that 22, 80 and 443 are dark, and prove SSH
   over the overlay still works.

Step 4 is never in the same unattended run as step 1. If step 2 fails, the firewall is not touched.

## 2. Access rules: deny by default

A policy file is written before the first box joins. The starter allow-all policy is never live, not even for an hour.

Tags (tags identify machines, not people):

| Tag | Who carries it |
| --- | --- |
| `tag:hivra-box` | Every Hivra box (hosted or the owner's own server) |
| `tag:hivra-bridge` | A bridge process on the owner's computer, only while the owner has it switched on (section 4) |
| owner devices | The owner's laptop and phone, as user devices (untagged, owned by the owner's identity) |

Grants:

| From | To | Ports | Default |
| --- | --- | --- | --- |
| Owner's devices | `tag:hivra-box` | TCP 22 (OpenSSH) | on |
| Owner's devices | `tag:hivra-box` | one named app port, if WP-195a's host needs it | off until that package ships |
| `tag:hivra-box` | `tag:hivra-box` | anything | **never** without a later, written need |
| `tag:hivra-box` | owner's devices | anything | **never** |
| `tag:hivra-box` | `tag:hivra-bridge` | the bridge's one port | only for the owner's own boxes, only while the bridge is on |

Policy tests live in the same file (`tests` / `sshTests` in Tailscale's huJSON format, which Headscale also reads), so
a bad edit is rejected before it is saved:

- the owner's phone can reach a box on 22;
- a box cannot reach another box on 22, 80, 443 or the bridge port;
- a box cannot reach the owner's laptop or phone on any port;
- a box of one owner cannot reach another owner's bridge.

Also: one-off, tagged, pre-authorised auth keys for each box, minted at provisioning and never stored in an image,
a repo or a brief; key expiry on for user devices; device approval on.

## 3. Choosing the overlay

| | Tailscale (SaaS) | Headscale | NetBird | Raw WireGuard |
| --- | --- | --- | --- | --- |
| Licence | Client BSD-3-Clause; control plane closed | BSD-3-Clause; uses official Tailscale clients | Client mostly BSD-3-Clause; `management/`, `signal/`, `relay/`, `combined/` are AGPLv3 | Kernel GPL-2.0; wireguard-go MIT |
| Cost | Personal $0 but **non-commercial only**; Standard $8 and Premium $18 per user per month | A small VPS plus our time; free | Cloud plan, or self-host for free | Free, but we build everything else |
| NAT traversal and relays | Global DERP network included | Use Tailscale's public DERP map or run our own DERP | Own relay (self-host) or theirs | None. We would build discovery, NAT traversal and relays |
| Phone clients | Official iOS and Android | Official Tailscale apps (custom login server) | Official apps | WireGuard app, manual keys |
| Access rules | huJSON grants, tags, tests | Same policy format (a subset; check per release) | Its own groups and policies | Hand-written firewall rules per peer |
| Who holds the keys | Tailscale's control plane decides which keys trust which; Tailnet Lock reduces that | We do | We do (self-host) | We do |
| Fit | Fine for Ash's own lab on a paid plan; wrong default for a shipped product on Personal | Best fit for the product | Good fallback; AGPL obligations if Hivra hosts or ships the server parts | Too much to build for a first version |

**Recommendation for the pilot: Headscale**, on a small dedicated VPS that is itself behind the same outbound-only
pattern, with the official Tailscale clients pinned to **>= 1.104.4** (current stable at writing: 1.104.6). For DERP,
start on Tailscale's public DERP map and plan our own DERP on one public Hetzner box before more than a handful of
customers depend on it; measure how often phones fall back to a relay during the pilot.

Why not the others first:

- **Tailscale SaaS on Personal** is non-commercial. Hivra is a product. A paid business tailnet is fine for Ash's own
  machines, and remains the right answer for an owner who brings their own tailnet (as hosted Hivra already allows),
  but Hivra should not run customers on our own Personal tailnet.
- **NetBird** is the fallback if Headscale plus official clients proves a bad fit. Record the AGPL parts in any later
  build PR.
- **Raw WireGuard** gives up NAT traversal, relays, phone onboarding and the policy language. Not for the first version.

If Hivra stays on Tailscale SaaS anywhere (Ash's own fleet, or a paid tailnet), turn on **Tailnet Lock** so a new node
cannot join until one of our own trusted nodes signs its key.

### Off in every design

- **Tailscale SSH: off.** Use OpenSSH over the overlay with keys and no passwords, bound to the overlay address. This
  avoids the Tailworm class of bugs (an SSH session reaching root-only sockets such as Docker's or `tailscaled`'s).
- **Funnel: off.** It publishes a tailnet service to the public internet, the opposite of an empty firewall. Public
  traffic goes through Cloudflare Tunnel. **Serve** (tailnet-only) is allowed later for a private web UI, under the
  same rules.
- **Exit nodes and subnet routes: off** on boxes (hosted Hivra already passes `--advertise-exit-node=false
  --accept-routes=false`).
- **Client version floor: 1.104.4.** The install step checks `tailscale version` after install and refuses to join
  below the floor. Today hosted Hivra installs whatever the install script serves; the build package adds the check.

## 4. The bridge to your own computer

The box must not reach the owner's computer, yet the customer ask needs a cloud agent to run a command there. The
answer is a **bridge the owner starts on their own computer**, not a network path.

How it works:

1. The owner switches on "Let my cloud agents run commands on this Mac" in the Hub app (or a small CLI for people
   without the app). This starts a bridge process on the Mac.
2. The bridge is its own overlay node, embedded with **`tsnet`** (Tailscale's Go library; it works the same against
   Headscale). It joins as `tag:hivra-bridge` with a one-off key, under its own identity, separate from the Mac's
   normal client. The Mac's own client, if any, stays untouched.
3. The bridge listens on one port on its overlay address only. It speaks one narrow protocol: `exec` with an argument
   list, a working directory inside an allowed folder, a time limit and an output cap. It returns stdout, stderr and
   the exit code. No interactive shell, no port forwarding, no file transfer in the first version.
4. The access rules (section 2) let only the owner's own boxes reach that port, and only while the bridge node exists.
5. Each request carries a short-lived token the Hub mints for one agent on one box. The bridge checks it, shows the
   command in the Hub, and by default asks the owner to approve it. The owner can choose "allow this agent for the
   next hour" (time-boxed) or "always ask". There is no "allow forever" in the first version.
6. Every request is logged on the Mac (who, which box, which agent, the command, the exit code, approve or deny).
7. **Revoke** is one switch: the bridge stops, its node is deleted from the overlay, and its tokens stop working. Closing
   the laptop or quitting the app has the same effect.

The test: with the bridge on and the owner approving, a hosted agent's `uname` returns `Darwin` and exit 0. With the
bridge off, the same request fails with a plain "the bridge on your Mac is off" message, and a network probe from the
box to the Mac's overlay address finds nothing open.

What this is not: not putting the Mac on a flat tailnet, not "all boxes can SSH to the Mac", not Tailscale SSH, not
Funnel, and not the hosted control plane reaching into the home network.

Phones are the same class: a phone on the overlay can reach boxes; boxes never reach the phone. The phone talks to
agents through the existing pairing (WP-150, WP-195a), not through a bridge.

## 5. Automatic overlay for every server

When this ships, provisioning a box (hosted or bring-your-own server) does the overlay step without the owner doing
anything, but the firewall step stays gated:

1. Provisioning mints a one-off tagged key, installs the pinned client, joins as `tag:hivra-box`, and records the
   overlay address.
2. The app shows "Private network: on" for that box and the overlay address next to the SSH command.
3. "Close public ports" is a separate button. It runs the lockout-rule checks (section 1, steps 2 and 5), shows the
   firewall plan, and applies it only when the owner presses Apply. A box with failed checks cannot close its ports.
4. For an owner who already runs their own tailnet, the existing "join my tailnet" panel stays, with a warning if the
   owner's policy has no tests and a link to a ready-made policy snippet matching section 2.

Hosted Hivra's own fleet servers follow the same steps, run by a human, one server at a time, after the pilot.

## 6. Hosted Hivra and a machine on your home network

Today's screen is right: hosted Hivra cannot and should not open a connection into a home network. With this package,
the way in becomes outbound from the home side:

- **A box the owner wants to add at home** runs the same pinned client and joins the owner's Hivra overlay as a
  tagged box. Hosted Hivra's agents then treat it as any other box on the overlay. No home router port is opened.
- **The owner's own computer** uses the bridge (section 4), not a box enrolment.
- The hosted control plane does **not** join the overlay as a peer that can reach boxes. It provisions over the paths
  it uses today and asks the box to report its overlay state. If a later need appears, it gets its own tag and its own
  written grant.
- `HIVRA_INFRA_ALLOW_PRIVATE_NETWORKS` stays off on hosted.

The screen copy changes only when the build ships. Until then it stays as it is.

## 7. Pilot (after Ash okays this page)

On throwaway machines only: one new Hetzner Cloud VM created for the pilot and deleted after, and Ash's Mac. No
production box, no customer box, no fleet server.

1. Headscale on a small throwaway VPS, the section 2 policy and its tests loaded first.
2. Join the pilot VM and Ash's phone; prove SSH over the overlay from Mac and phone.
3. Write the firewall plan; Ash applies it; prove 22, 80 and 443 are dark from outside and SSH still works inside.
4. Prove the denials: VM to Mac, VM to phone, and (with a second throwaway VM) VM to VM all fail.
5. Run the bridge as a manual prototype on the Mac; prove `uname` returns `Darwin` and exit 0 with approval, and fails
   with the bridge off.
6. Write up results, relay rates for the phone, and anything that changes this plan, as a reply on this page's PR.

## Build packages that follow (not started)

- **WP-220a** Overlay enrolment for boxes, with the version floor and tagged one-off keys (hosted and Hub host).
- **WP-220b** The "Close public ports" flow with the lockout checks and a human Apply.
- **WP-220c** The bridge on the owner's computer (`tsnet`, exec protocol, approval, log, revoke).
- **WP-220d** Hosted Hivra's "join my tailnet" panel: version floor and policy warning.

Each is Grok OK: no, ships behind a flag that is off by default, and needs the WP-203 hard review before merge.

## Done when

- [ ] Ash has read this page and okayed it, or said what to change.
- [ ] The pilot in section 7 has run on throwaway machines, with the proofs attached.
- [ ] The build packages above have their own pages.

## Sources

- The late-October 2026 Hetzner hardening thread (Pieter Levels) and its replies: outbound tunnels, emptied firewall,
  per-box isolation, the lockout warning, and "write the plan first, a human applies it".
- Tailscale docs: how Tailscale works, DERP servers, ACLs and grants, tags, auth keys, `tsnet`, Serve, Funnel, Tailnet
  Lock, pricing (read 11 Nov 2026).
- Tailscale's "Tailscale SSH: findings and fixes" post and security bulletins from TS-2026-015; the independent
  tailworm.com report.
- Headscale (github.com/juanfont/headscale), NetBird (github.com/netbirdio/netbird), wireguard-go,
  cloudflared.
