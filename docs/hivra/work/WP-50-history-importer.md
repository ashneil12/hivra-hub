# WP-50: Chat-history importer

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 21 | no |

## Goal

Hivra can read a person's past agent conversations, with their OK, and distil how they work into memory that cites
where each line came from.

## Why

Ash: conversation history is "a goldmine" of how they think and work (vision item 6). Raven's importer and
provenance rule, Agent Zero's migrate-agents preview.

## Read first

- Raven (Apache-2.0, ideas): `raven/importer/` (scan, filter noise, batch, retry, resume) and the consolidator's
  rule that unsourced bullets are dropped.
- Agent Zero (MIT): `plugins/_migrate_agents` (preview, then import).
- CLAUDE.md "Conversations" (Claude Code keeps every transcript under `~/.claude/projects/.../*.jsonl`); the Hub's
  secret scan used by Export (`docs/PORTABLE.md`).

## Build

1. **Sources, opt-in one by one**: Claude Code transcripts first, then Codex, then Hermes. A preview shows how many
   conversations, from when, and from which projects, before anything is read in full.
2. **Pipeline**: resumable, batched, cancellable, with progress; skips tool noise; runs the secret scan on every
   chunk and drops anything that matches.
3. **Output**: plain Markdown memory files (a profile of how the person works, preferences, recurring decisions),
   where every line links to the conversation and message it came from. A line without a source is dropped.
4. **Model and cost**: the person picks the model and sees an estimate before it runs. Nothing leaves the machine
   except calls to the model they chose.
5. Results land as proposals the person reviews in WP-51's memory screen; nothing is applied silently.

## Done when

- [ ] Tests on fixture transcripts: resume after cancel, secret dropped, every output line has a source, a line
      without a source is removed.
- [ ] `npm run check` passes; a dev-copy run on a copy of real transcripts, reviewed by Ash.
