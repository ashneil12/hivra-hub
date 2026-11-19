# Building Hivra: start here

This folder is the build spec for Hivra, written for the agents that build it (Claude Code, Codex, Grok and the
rest). People don't need to read it; Ash's one-paragraph version of the plan lives in the project chat.

Read in this order:

1. [SPEC.md](SPEC.md): what Hivra is, the few ideas it is built on, and what stays, changes or goes.
2. [PLAN.md](PLAN.md): how the work is split, the order it runs in, and the rules every package follows.
3. [UX.md](UX.md) when your package changes anything a person sees: the one model every screen follows, the mockups,
   and how a UI change is checked (before and after screenshots, looked at before merge).
4. The work package you were given, in [work/](work/). Each one says what to read, what to build, what not to touch
   and how to prove it is done.
5. [SOURCES.md](SOURCES.md) when your package takes an idea or code from another project: what we take from where,
   under which licence, and how to credit it.

The repo's [AGENTS.md](../../AGENTS.md) still governs how you build, run and ship anything here (dev copies,
`npm run check`, never touching the daily app), and [CLAUDE.md](../../CLAUDE.md) imports it. Where this folder
and those disagree, they win until a package changes them.

## The short version

Hivra is MonoCode, kept up to date with upstream, made simpler rather than bigger. Every agent you talk to is a
**first mate** with its own **crew**: the **coding team** is the plain, general one for a project, and each **Mono**
is a first mate specialised by its soul, skills, memory and crew. A first mate never does the work itself. It briefs
workers on any CLI in their own worktrees, plain code watches them without spending tokens, and nothing counts as
done until it is proved. **Groups** are optional rooms where first mates talk; a **council** is a group with rules.
**Plugins** use the open Agent Plugins format with DeepSeek Harness's install, Discover and Creator ideas on top,
and dashboards (Pages) are one kind of plugin. The Hub's engine stays; its robotic layers go.

## Ground rules, in one screen

- **Curate, don't invent.** Before designing anything, check [SOURCES.md](SOURCES.md) for a proven design. Port the
  idea, vendor code only where the licence allows, and credit it.
- **Keep what works.** The delegation engine, restart-safe resume, ship with rollback, dev copies, the Pages
  sandbox and autopilot are tested and stay. Improve them in place; don't rewrite them.
- **Code owns the mechanics, agents own the judgment.** Spawning, watching, merging, status and limits are code.
  The model decides what to do, never whether a check passed.
- **Done means proved.** Every package ships with tests, and anything a person can see ships with a browser spec
  or a dev-copy check.
- **Minimal, not robotic.** Fewer states, fewer cards, plain words. Messages report outcomes, not mechanics.
- **Stay mergeable with upstream MonoCode.** New code goes in new modules; upstream files get the smallest hook
  that works.
- **Windows-ready.** No bash in the core. Anything platform-specific is behind a platform check with the others
  planned.
