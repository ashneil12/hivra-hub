# WP-21: Monos are first mates

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | M | 05, 20 | no |

## Goal

Every Mono is a first mate with a specialty: its own soul, memory, skills, habits and crew rules. A Mono can brief a
project's coding team, which runs its own crew.

## Why

Ash: "any agent that you talk to, for example the monos… are all essentially First Mates with their own crews,
specialized to whatever that mono is". SPEC.md sections 3 and 5.

## Read first

- Upstream Monos (`src/features/monos`, `src-tauri/src/mono*.rs`) and the Hub's Mono home (`mono_home.rs`).
- `followedBriefs.ts` (a Mono's brief to a Lead's long-running chat: the nested case that already works).
- Mercury's soul files (an upgrade never overwrites a person's edits) and OpenMausBot's bot list (contacts, per-bot
  model and tools, context menu): ideas only.
- WP-05's templates, WP-10's contract, WP-13's crew rules.

## Build

1. A Mono's turn runs on the first mate contract plus its soul. Its crew rules (WP-13) are its own, so a design
   Mono can prefer different CLIs or plugins than the coding team.
2. **Nesting**: a Mono's crew member can be a project's coding team (depth 2: Mono, coding team, workers), using
   the existing followed-brief path. The Mono sees one line per brief; the detail is in that project's Crew tab.
3. **Monos as contacts**: one list with each Mono's name, title, last line and unread state; a context menu to pin,
   mute, duplicate, edit profile or remove. New Monos come from templates (WP-05, plugins) or from scratch.
4. Soul and memory files a person edited are never overwritten by an update (keep `soulTamper`'s guarantees).

## Done when

- [ ] Tests: a Mono's turn carries the contract and its soul; a Mono brief to a coding team runs at depth 2; a
      third level is refused; an edited soul survives a template update.
- [ ] Browser spec for the Monos list and its menu; `npm run check` passes.
