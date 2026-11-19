# WP-194: Your own subscription, lent to another machine for one session

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | L | 60, 61, 92 | no |

From PLAN.md, "From Aether", item 2. Aether is closed source: ideas only, nothing credited.

## Goal

When a session runs on another machine (an added host, a task machine, later a Hivra Cloud machine), the person can
lend it the provider login or key they use on this Mac, for that one session. The credential lives only in that
session's process on the other machine, is gone when the session ends or the time limit passes, and the person can
take it back at any moment. Nothing is stored there.

## What Hivra has

- On this Mac, each CLI uses the person's own sign-in; Hivra never reads it (`credentialGuard.ts` blocks agents from
  the Keychain and the CLIs' own sign-in files, `CREDENTIAL_DENY_RULES`).
- A host uses the host user's own logins (`docs/remote-access.md`; WP-177's move between machines copies no login).
  Export and dev copies strip secrets on purpose (`src-tauri/src/portable.rs`, AGENTS.md).
- WP-92's vault: a key pasted once into a form card goes to the Keychain, and one approved command gets it for one
  run with the value taken out of the output.
- The host connection: an SSH forward to a loopback host (`src-tauri/src/remote_ssh.rs`, `remote.rs`
  `remote_request`); the renderer never sees the saved bearer credential.

## What to build

1. **What can be lent.** Two kinds, each only where it is documented:
   - **An API key** held in the WP-92 vault (an Anthropic, OpenAI or other provider key the person saved there).
   - **A subscription token**, only for a CLI whose own documentation describes a token for use on another machine
     and the variable it reads. The PR links that page and its date for each CLI it enables. A CLI with no documented
     way is shown as "can't be lent; sign in on that machine".
   Hivra never copies a CLI's own sign-in file.
2. **The lend card.** Starting a session on another machine whose CLI is not signed in there shows: "Lend your Claude
   login to build-box for this session? It is removed when the session ends, or in 8 hours." Lend once, or Not now.
   Each lend needs the person's tap; agents, habits and automations cannot lend.
3. **Delivery.** The desktop reads the value from the Keychain at the tap and sends it through `remote_request` over
   the existing SSH forward, in one new host method `credentials.lend(session, cli, value, expires)`. The host keeps
   it in memory only, puts it into that one provider process's environment, and never writes it to disk, a log, a
   record or a crash report. It is dropped when the process exits, the session ends, the time passes, or the person
   taps Revoke (`credentials.revoke`), which also stops the process.
4. **Guards on the other side.** The host applies the same credential guard to that session: the lent variable's name
   is added to the blocked reads (`printenv NAME`, `env`, `/proc/<pid>/environ`), and its value is scrubbed from every
   output the host sends back.
5. **What the person sees:** a line on the session ("Using your Claude login, lent until 18:40") with Revoke, and one
   activity log line per lend and revoke, never the value. A token the provider issued stays valid at the provider
   until the person revokes it there; the card says so and links the provider's page.

## Rules

- Off by default: Settings > Machines > "Allow lending my logins to other machines". With it off, no card and no host
  method call.
- Never sent anywhere but a machine the person added, over the existing encrypted SSH forward. No relay, no Hivra
  service, no new outward call.
- Refused in a dev copy and under a temporary HOME (they have no daily Keychain names), except in tests with a stub.
- Never weakens approvals, the credential guard or the protected-path list (`src/shared/security/agentConfigPaths.json`,
  when it exists). A Hivra Cloud machine uses the same path once WP-61 exists; until then it is not offered.
- Upstream rules from PLAN.md: new host method and module; `remote.rs` gets one call, no stored state.

## Done when

- [ ] Red first: a host test starts a session with a lent value and asserts the value is in no file under the host's
      data folder, no log line and no record (it fails until the lend path keeps it in memory only).
- [ ] Tests: expiry drops the value and stops the process; revoke does the same at once; a second session does not see
      the first one's value; `printenv NAME` from the agent is blocked; the value is scrubbed from output.
- [ ] Tests: with the setting off nothing is sent; an agent-initiated lend is refused; a dev copy refuses.
- [ ] Browser spec `tests/browser/lend-login.spec.ts`: the card, the session line with its time, and Revoke.
      Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check against a real SSH host with a test key stays open until done.

## Not in this package

Storing a login on another machine. A Hivra Cloud credential service. Sharing a login between people (WP-80).
