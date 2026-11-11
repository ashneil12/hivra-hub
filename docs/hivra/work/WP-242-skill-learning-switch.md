# WP-242: One switch for skill learning (Automatic, Ask first, Off) and safer learned skills

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | S | WP-51 | yes |

## Goal

Ash decides how skills are learned, in one place. A learned skill is cleaned of personal details before it is saved.

## Why

- There are two paths today. `skill_learn` (`selfBuild/model/skillLearn.ts`) applies a lesson at once, with Undo
  (Ash, 14 Oct). The WP-51 curator's skill proposals wait for him to accept them.
- nightly-labs OpenBot (ideas only) has one setting: Automatic, Ask first or Off.
- Nod (Apache-2.0, `src/server/learned-skills.ts`):
  - a cheap model rewrites a learned procedure with placeholders for personal details and drops steps that send
    things out;
  - a patch must match exactly one passage;
  - at most 40 skills, least recently used out first, never one the owner edited.

## Build

1. Settings → Memory: "Learn skills: Automatic / Ask first / Off". The default is **Automatic**, which keeps
   today's `skill_learn` behaviour. "Ask first" routes both paths through the WP-51 accept card. "Off" drops both
   and counts the drops on the health card.
2. Before saving any lesson or skill, the cheap tier replaces names, emails, paths in the home folder and
   account ids with placeholders, and drops steps that send outside. When the cheap tier is off, a regex pass does
   the same.
3. A lesson edit must match exactly one passage in `SKILL.md`; otherwise it is refused with a plain line.
4. Cap learned skills at 40 per home. Evict the least recently used first, never one Ash edited.

## Done when

- [x] Tests for each mode on both paths, sanitising, the exactly-once patch, and eviction
  (`selfBuild/model/skillRoute.test.ts`, `selfBuild/model/lessonSafety.test.ts`).
- [x] Browser spec of the setting, with before and after screenshots (`tests/browser/wp242-skill-learning.spec.ts`,
  `shots/wp-242/`).
- [x] Credits: no Nod or OpenBot code or text was copied (ideas only), so NOTICE is unchanged; credits.json names what
  Nod gave.
