# WP-83: Agents learn from past chats, with evidence

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| F | L | 50, 51 | yes |

## Goal

Hivra reads what actually happened in past agent chats and proposes small edits to the agents' instructions and
skills, and to a profile of the person's opinions and voice. Every edit carries quotes from real chats, needs at least
two of them, and changes nothing until the person accepts it.

## Why

Ash, 4 Nov: shared three of Kun Chen's repos.

- [backpass](https://github.com/kunchenguid/backpass) (MIT, JavaScript) treats instruction files as weights and chat
  transcripts as the signal:
  - verbatim quotes are checked against the transcript;
  - every add, rewrite or remove needs two distinct sessions;
  - a ledger keeps corroboration across runs;
  - rejected edits are remembered;
  - edits are measured from a staging copy, never taken from the model's word;
  - a token budget;
  - model calls go through a CLI the person already signed in to, with no keys of its own.
  It is the rigorous version of WP-51's curator.
- [kun](https://github.com/kunchenguid/kun) (no licence, so ideas only) keeps a person's `OPINIONS.md` and `VOICE.md`
  refreshed daily from what they said, for agents to read.
- Kun's [dotfiles](https://github.com/kunchenguid/dotfiles) (MIT-0) give every agent CLI one shared `AGENTS.md`.

## Read first

- backpass `README.md` ("How It Works" sections 1 to 10, "Limitations"), `VISION.md`, and `src/`: `discovery/`
  (transcript adapters for claude, codex, pi, opencode, grok, cursor and hermes), `gap-ledger.js`, `overlap.js`,
  `consolidate.js`, `proposal.js`, `diff.js`, `redact.js`, `tokens.js`, `prompts/`, `apply/`, and its tests and
  golden fixtures.
- kun `ENTRY.md`, `OPINIONS.md`, `VOICE.md` (the shape only: headed opinions, each with its reasoning and evidence
  links, and a dated voice profile).
- Hivra: WP-50 (`src-tauri/src/history_import.rs`, `prompt.ts`, `write_proposal`), WP-51 (curator and memory screen),
  `mono_home.rs` (SOUL.md), skills (WP-41), secret patterns (`portable.rs`, `secrets.ts`).

## Build

1. **Copy backpass's logic** with its MIT header and a credits.json and `NOTICE` entry. Its rules are plain
   JavaScript, so vendor them as TypeScript in `src/features/memory/backpass/`, keeping its tests: the two-session
   rule, the ledger, overlap judged from evidence, rejection memory, staging-copy diffs and the budget.
2. **Transcript readers.** Reuse WP-50's readers. Translate backpass's adapters for the stores WP-50 doesn't read
   yet into Rust beside them, and port each adapter's golden fixture as its test. Reads stay inside the stores, with
   no symlinks and with WP-50's size caps.
3. **Model calls** go through the engine the person already signed in to (Claude Code or Grok CLI), as backpass does
   through acpx. No API keys. Secrets are redacted before anything is sent (backpass's `redact.js` plus Hivra's
   patterns).
4. **What it can edit.** It never widens beyond what the run names:
   - a project's instruction file;
   - a first mate's SOUL.md and skills;
   - the person's user-level file, only when they pick it.
5. **The person's profile** (kun's idea): `opinions.md` and `voice.md` in Hivra's data folder. Each opinion has its
   reasoning and links to the chats it came from, under the same two-chat rule. Agents read opinions for judgment
   calls. They read voice only when drafting something in the person's name. The person can edit either file.
6. **One instruction file** (dotfiles' pattern). Where Hivra writes instructions for more than one engine, it keeps
   one `AGENTS.md` and makes `CLAUDE.md` a one-line `@AGENTS.md` import, so an accepted edit lands once.
7. **Review in WP-51's memory screen.** Each proposal shows its diff and the quotes behind it, and is accepted or
   rejected on its own. Nothing is written without that. "Learn from recent chats" runs on demand. A weekly run is
   available, off by default. The token cost is shown before a run starts.
8. **Dev copies** read only transcript stand-ins that a test names, never `~/.claude`, `~/.grok` or the other real
   stores.

## Done when

- [ ] Tests, ported from backpass where it has them:
  - a gap seen in one chat makes no proposal; the same gap in a second chat does;
  - a quote that isn't in its transcript is dropped;
  - a rejected edit isn't proposed again without new evidence;
  - the budget is respected;
  - nothing is written before accept;
  - the redaction patterns;
  - each adapter's fixture.
- [ ] Browser spec: proposals with quotes in the memory screen, accept and reject.
- [ ] `npm run check` passes. Dev-copy check with stand-in transcripts.
