# What I read, and what I need from you

I have not changed anything yet. Here is what the three items look like from the code:

1. **Turn duration.** `src/session.js` already computes `elapsedMs` on every turn, so the session view just is not
   drawing it. Nothing needs to be added to the model — only the view.
2. **The limit.** `src/limits.js` exports a single `LIMIT = 10` used by `canStart`. Making it per project means
   deciding where the value lives and what happens to projects that set nothing.
3. **The README.** It says the code is in `lib/`; the files are in `src/`. That one is a straight correction.

Before I touch anything:

- Should the per-project limit come from the project's own config file, or from a setting inside the app?
- When a project has no limit set, keep 10 as the default, or fall back to the parent folder's value?
- For the turn duration: a live seconds counter that updates, or the duration shown once the turn ends?
- Do you want the README correction on its own small change, or together with the limit work?

Tell me which way you want each and I will start.
