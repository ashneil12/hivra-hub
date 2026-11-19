# WP-177: Teleport a chat between this Mac and a host

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 60, 61, 121, and 133 for the transport choice (not yet in the tree) | no |

## Goal

The person can send a running chat from this Mac to a host machine they have added, and bring it back. The chat keeps its id, model, effort and provider transcript, so the agent resumes where it stopped. A chat is on one machine at a time: never on both, even if the Mac sleeps or the connection drops in the middle of a move.

## Why

Hivra keeps an interactive chat on the machine where it started. WP-60 moves a project's first mate, delegation records and watcher to a host, and WP-61 adds a cloud machine. Neither moves a chat the person is already in. Cloudroom (Apache-2.0) shows the pattern: freeze the session, move its recorded history, and resume it with the same chat, model and effort. Aether is already in SOURCES as ideas only, but it is closed source.

What exists today: `src-tauri/src/provider_session_transfer.rs` copies a Claude or Codex transcript between two accounts on the same machine, so a usage limit does not strand a chat. `src/features/sessions/model/handoff.ts` writes a brief when a chat changes harness. `src-tauri/src/remote.rs` and `src/features/connections/` show a host's sessions on the desktop. None of them hands a live chat from one machine to another.

## Read first

- WP-60 (leases and idempotent launch keys: a live holder is not replaced, and a dead one counts as released) and WP-61.
- WP-121 (the resume case and the recap fallback, with no silent switch).
- WP-133 (design only, `docs/hivra/work/WP-133-remote-parity.md`), which owns the laptop-closed transport and the relay. This WP builds only the SSH host connection and does not decide the relay.
- `src-tauri/src/provider_session_transfer.rs` for the transcript copy rules.
- Cloudroom's README (ideas only, no code copied): the split of harness from core, and teleport as freeze, move history, resume.
- PLAN.md, "From Aether": the subscription gap, which applies here too.

## Build

**What is carried, stated plainly.** A move carries the chat's saved messages, its model, effort, title and queued messages. It does not carry the CLI's own transcript file. The target starts a fresh CLI session from the saved messages, and the notice says so ("continues in a fresh session there, started from the saved messages"). The recap is the fallback when the target cannot resume. This keeps the move to files Hivra already saves, and it is what the tests prove.

1. A move is a custody handover, not a copy. The source freezes the chat, the transcript and Hivra's own record of the chat are copied, the target records the chat as its own, and only then does the source let go. A lease from WP-60 names the owner at each step, so a reconnect race cannot leave the chat running twice.
2. Freeze rules: refuse while a turn is running or an approval is pending. Never inject into a blocked chat. Offer "finish this turn, then move" instead. A chat with queued messages keeps them with the move.
3. Model and effort travel with the chat. If the target CLI cannot resume that transcript, refuse with the reason and offer the WP-121 recap into a new chat. No silent switch.
4. On the target the chat shows a marker ("Moved to <host>, <time>") and the desktop shows it as on the host, reading it through the host the way remote sessions already work. Moving back uses the same steps in reverse. The host's copy is removed only after the desktop confirms it holds the chat.
5. Credentials: the host uses its own Claude or Codex login. No login, key, token or subscription file is copied in a move, a manifest or an export. The export and dev-copy secret rules in `src-tauri/src/portable.rs` stay as they are. Portable export is not the move mechanism.
6. Out of scope: relay, phone or web access to a moved chat (WP-133 and WP-149), the cloud service (WP-61), delegations and watchers (WP-60), a second session list, and any new chat mode.

## Owned paths

- `src-tauri/src/portable.rs`
- `src-tauri/src/provider_session_transfer.rs`
- `src-tauri/src/remote.rs`
- `src/features/connections/`
- `src/features/sessions/model/handoff.ts`

## Done when

- [ ] A chat moved from the Mac to a stubbed host, then back, keeps its id, model, effort and transcript, with the transcript identical on each side at the moment of the move.
- [ ] A chat with a running turn or a pending approval is refused with the reason, and it moves once the turn settles.
- [ ] A reconnect race (desktop and host both ask to resume) starts the chat once. The loser sees the result, not a second run.
- [ ] A target whose CLI cannot resume the transcript gets the refusal and the WP-121 recap path.
- [ ] No provider login, key or token is written into the move, the manifest or an export.
- [ ] `npm run check` passes. A browser spec covers the "on host" marker and the refusal copy.

## Licence

Ideas from Cloudroom (Apache-2.0, https://github.com/davidondrej/cloudroom) and Aether (closed source, ideas only). No Cloudroom code is copied. If any file is translated later, stop unless this brief asked for it, then follow WP-121's rules: file header, NOTICE entry, credits.json component, README line and SOURCES row.

## Addendum (11 Nov): what Sheprd and Nuphos do

Research: `/mnt/project-files/hivra-research/reports/nov11-competitors.md`.

- **Sheprd** (Apache-2.0): Teleport moves the CLI's own transcript (Claude Code or Codex) and rewrites the folder
  paths inside it, so `--resume` on the new machine keeps the full history. Prefer this.
- **Nuphos** (Apache-2.0): moving a chat takes an expiring lock and the chat's run slot, and a final write
  succeeds only while the lock still holds. The new machine starts a fresh session from a text history (summary
  first, newest turns kept within a 120K-character budget). Use that history as the fallback when the transcript
  can't move.
