# pstack test fixture (WP-30)

The real `plugin.json`, `LICENSE`, `agents/` and every `skills/*/SKILL.md` of pstack by Lauren Tan
(<https://github.com/cursor/plugins/tree/main/pstack>, MIT, see LICENSE), copied unchanged from
`cursor/plugins` at commit `6ea74587e384e1a8035c09ae33a46fe3f881eb9b`. Skill assets, scripts and references are left
out to keep the fixture small; the loader only needs each `SKILL.md`. Used by `src/plugins/tests.rs` to prove
Hivra loads a real Agent Plugins package. Not shipped in the app.
