# WP-184: One page for every command and skill

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 30, 41 | yes |

From PLAN.md, "Ideas from kitze's factory teaser", item 5. Ideas only, nothing credited.

## Goal

One library page lists every skill and every slash command Hivra can offer, where each came from (a plugin, the
project, the person's own folder, a CLI's own folder), and how often the person picked it. One search box finds any of
them by name or description.

## What Hivra has

- `src-tauri/src/skills.rs`: `list_skills` returns `DiscoveredSkill` (`name`, `description`, `path`, `scope`,
  `source`), from each CLI's skill folders (`.claude/skills`, `.hermes/skills` and the rest, up to `MAX_SKILLS`).
- `src/features/skills/ui/SkillsPage.tsx`: upstream's page for file skills (inspect, create, turn off). It has no
  commands and no plugin column.
- Plugin commands: `commands/<name>.md` in a plugin's Hivra folder, read into `commands: Vec<Command>` by
  `src-tauri/src/plugins/hivra.rs`; installed plugins are listed by `src-tauri/src/plugins/registry.rs`.
- pstack and mcode indexes (`pstackIndex.generated.json`, `mcodeIndex.generated.json`) name which plugin a skill is in.
- The slash picker ranks skills with `rankSkills` in `src/features/skills/model/slashCommands.ts`.

## What to build

1. **One list command** `library_list` (Rust, new file `src-tauri/src/skill_library.rs`) that joins `list_skills` with
   the installed plugins' skills and commands. Each entry: kind (skill or command), name, description, origin
   (plugin name and version, project, personal, or the CLI that owns the folder), path, and whether it is turned off.
   The same name from two origins shows twice, each with its origin, never merged.
2. **Counts on this page only:** how many skills and commands each origin brings, and "picked N times in the last 30
   days" per entry. The pick count is a small store the slash picker writes when the person chooses an entry
   (name, origin, day); 90 days kept. Agents reading a skill by themselves are not counted (Hivra cannot see that
   reliably), and the page says so in one line.
3. **The page** (`src/features/skills/ui/LibraryPage.tsx`, new): a search box (name and description, using the
   existing `fuzzyMatch`), filters for kind and origin, and a row per entry that opens the existing
   `SkillDocumentPreview` for a skill or the command's markdown for a command. Turning a skill off reuses
   `saveDisabledSkillPaths`; a plugin's entries link to that plugin in Settings > Plugins.
4. The finder (WP-74) gains skills and commands as one more result kind, opening this page on the entry.
5. The library opens from Settings > Skills (upstream's page stays as the "Files" tab beside it).

## Rules

- Read-only apart from the existing turn-off switch. Nothing here installs, edits or deletes a skill or command.
- No new outward network call; Discover (WP-32) stays where it is.
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- The pick counter stores names and days only, never prompt text, and travels with export like other settings.
- Counts stay on this page; nothing is added to Home (WP-73 rule 6).
- Upstream rules from PLAN.md: `SkillsPage.tsx` gets a tab hook, not a rewrite.

## Done when

- [ ] Red first: a Rust test installs a fixture plugin with one skill and one command and expects both from
      `library_list`; it fails before the command exists.
- [ ] Tests: the same name from a plugin and a personal folder gives two rows with their origins; a turned-off skill
      says so; counts per origin; the pick store drops days older than 90.
- [ ] Browser spec `tests/browser/skill-library.spec.ts`: search, both filters, opening a skill and a command, the
      origin counts, and a picked entry's count rising after a pick in the composer. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

Which skill a message gets (WP-190). A Mono's own skill list (WP-182). Discover and install (WP-32, WP-31).
