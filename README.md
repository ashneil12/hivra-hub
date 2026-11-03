<h1 align="center">Hivra</h1>

<p align="center">
  <strong>An experiment in running projects with a team of agents.</strong><br />
  A fork of <a href="https://github.com/hardbeat920/monocode">MonoCode</a>.
</p>

> [!WARNING]
> **This is an experiment. Don't take it seriously.** Hivra is Ash's personal build, made in public. It
> changes all the time, it isn't supported, and it may break. If you want a working app, use
> [upstream MonoCode](https://github.com/hardbeat920/monocode).

## What this is

Hivra is a fork of [MonoCode](https://github.com/hardbeat920/monocode), a desktop GUI for coding agents
(Claude Code, Codex, Cursor, Grok Build, OpenCode, Hermes and others). It stays a MonoCode fork on purpose
and keeps merging upstream changes in.

On top of MonoCode, Hivra is a harness for **managing** agents rather than chatting with one: a lead that
takes your asks, hands work to agents across your projects, keeps track of what's done and what isn't, and
comes back to you when it needs a decision.

The idea is to **curate, not invent**. Instead of building every piece from scratch, Hivra picks proven
pieces and puts them in the right places: a few ship by default, and the rest are optional plugins. It
should stay small.

## Inspirations so far

- [MonoCode](https://github.com/hardbeat920/monocode): the app Hivra is built on.
- [firstmate](https://github.com/kunchenguid/firstmate): an "agent distro" with a captain and a pluggable crew.
- [DeepSeek super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype): a router that
  never does the work itself, workers that follow threads, and a watchdog.
- [pstack](https://github.com/cursor/plugins/tree/main/pstack) and [poteto](https://x.com/poteto)'s writing
  on skills and verification, including the
  [verification skill example](https://github.com/poteto/verification-skill-example).

This list will grow.

## Status

Early. The plan is still being worked out, so expect the code and this page to change a lot. Agents
working in this repo should read [CLAUDE.md](CLAUDE.md) first.

## Building

Same as MonoCode: Node.js 20+ and a stable Rust toolchain. See [build setup](docs/building.md). This fork
has its own build and dev scripts (`npm run hub:dev`, `npm run hub:build`), described in
[CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE), like MonoCode. Hivra is not affiliated with MonoCode or with the makers of the agents it
drives. Provider names and logos are trademarks of their owners. See [NOTICE](NOTICE).
