# WP-150: Mobile pairing API, Inbox, crew, approvals (flag off)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Mobile | M | WP-149; WP-119 for crew/Inbox shapes if merged | **no** |

## Goal

Extend `src-tauri/src/mobile_access.rs` allowed methods so a paired phone can list waiting-on-him items (Inbox / decisions / approvals), read crew status, and approve or deny a single tool call with the exact command shown. All behind existing `enabled: false` default and `phone_access` policy. **Security-sensitive: parked for Ash, who approved the merge on 10 Nov 23:26 after a hard review with no high findings. Phone access stays off until he turns it on.**

## Why

Inherited phone can chat and answer agent questions but cannot approve tools or see Hivra Inbox/crew (phone-base report). Ash wants basics working privately.

## Who may call a method

A call is refused unless every line below is true. A miss is an error, never an empty success that looks like "nothing is waiting", and never an allow.

- Mobile access is on (`enabled`). It defaults to off, so nothing listens until someone turns it on.
- This copy's `phone_access` policy is on. A dev copy and a copy under a temporary home keep it off, even if the saved flag says on.
- The caller is a device that enrolled with `device.enroll`, is still in the device list, and has not been revoked. Revoke removes its key before the next call is served. A call already in flight is dropped when the reply comes back if the key is gone.
- The desktop window published the workspace. No window means no inbox, no crew, and no approval.

Prefer Tailscale or the LAN. `open_router` defaults to off on main (a new setup opens no router port), and it is only consulted after mobile access is on. This package does not change it and does not add push tokens.

## Methods

| Method | Who | What it does | What it never does |
| --- | --- | --- | --- |
| `inbox.list` | Paired device, flag and policy on | Read-only waiting lines: decisions, questions, credential and permission asks, failures, reviews, and tool approvals still waiting. Questions first, then permissions and approvals, then failures and reviews. Longest wait first. Each approval line includes the tool, the exact command, and the paths. | Answer a decision, approve a tool, or report an empty list when the store could not be read. |
| `crew.status` | Paired device, flag and policy on | Read-only crew rows: status, branch, pull request, checks. | Stop, message, retry, land, or open a pull request. The reply has no actions. |
| `session.approve` | Paired device, flag and policy on, and only for one waiting tool call | Calls the desktop's existing approval path with allow, after the request id, tool, command, and paths match the call the desktop published. The reply repeats the exact command. | Allow when the id is missing, already decided, duplicated, or not the published call. No "approve all". A conflicting `decision` is a refusal. |
| `session.deny` | Same as approve | The same match, then the desktop approval path with deny. | Turn into an allow. A missing decision does not default to allow. |

`inbox.list` and `crew.status` take an optional `projectId` (the same encoded project id the workspace poll already uses). Without it they cover every project the desktop has, except a home folder. `session.approve` and `session.deny` take `conversationId`, `requestId`, `tool`, `command` (null when the tool has no command), and `paths`.

An approval the desktop did not publish is refused in the pairing service, before the window is asked. The window matches only the calls the catalog published too, and refuses when it is given no list. A private chat (WP-111) never publishes a call. A decision the window cannot send is refused and the call stays answerable. The window checks the live session again and refuses if the call changed, the turn ended, or the session is a worker the lead answers. A second decision for the same call is refused. The answer is remembered by the call's own block id, not its request id, because request ids start again at 1 each time a harness process restarts.

A Mono's room-session call is not published. A room turn's approval is answered through the Mono habit relay (the desktop sets it "cancelled" when no relay is waiting), not through the direct approval the phone calls, so a phone "allow" there could report done without the tool running. The phone shows no line for it and cannot answer it (fail closed). A Mono's own one-to-one chat is published: its approval is a plain harness call, answered directly. Every listed chat is published too.

## Build

1. Docs copy; list every new method and who may call it.
2. `session.approve` / deny calling existing desktop approval path; never default allow; show exact command.
3. `inbox.list` / waiting lines; `crew.status` read-only.
4. Tests: flag off → methods rejected; flag on without policy → rejected; approve requires matching requestId; revoke device drops access.
5. Keep `open_router` off by default (main's derived default); prefer documenting Tailscale/LAN. No push token work unless already gated.

## Done when

- [x] Methods + tests; default remains off.
- [x] Hard-review notes in untracked REVIEW.md; PR stays draft / unmerged.
- [x] Approve and deny match only the published calls; a private chat's calls are never published.
