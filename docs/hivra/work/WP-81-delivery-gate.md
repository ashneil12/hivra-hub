# WP-81: Every crew's work is checked before it reaches GitHub

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| F | L | none (70 and 78 when merged) | yes |

## Goal

When a crew finishes, its branch doesn't go straight to GitHub. A local gate checks it in a throwaway copy first
(review, tests, docs, lint), fixes what is mechanical, and asks the person only about real judgment calls. Then it
pushes, opens a clean PR and repairs failing CI. The person sees the check on the task card, and a judgment call
reaches them as one plain question.

## Why

Ash, 4 Nov: shared Kun Chen's [no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT, Go, macOS, Linux and
Windows). It is the review-and-fix loop the integration thread has been running by hand for every Grok package,
built carefully: it never loses work, every human decision binds later steps, and it supports Claude, Codex and Grok
with fallbacks. It releases almost daily, so Hivra **uses it as a pinned tool** rather than porting about 26 MB of
Go. Same author as firstmate, which Hivra already ports.

## Read first

- no-mistakes `README.md`, `VISION.md`, and its docs under `docs/src/content/docs/`: `concepts/gate-model.md`,
  `concepts/pipeline.md`, `concepts/auto-fix.md`, `concepts/daemon.md`, `reference/pipeline-steps.md`,
  `reference/cli.md` (the `axi` section: `axi run`, `respond`, `answer`, `status`, `abort`), `reference/environment.md`
  (`NM_HOME`, the socket-path limit), `reference/global-config.md` (`agent`, `worktree_roots`, `auto_fix`) and
  `reference/repo-config.md`.
- Hivra: how a crew delivers today (firstmate's delivery modes and merge authority, WP-12 and WP-13),
  `src-tauri/src/land.rs`, `src-tauri/src/pr_watch/`, the plugin installer's pinned downloads and checksums (WP-31),
  WP-70 (task card states), WP-78 (activity log), WP-14 (decisions).

## Build

1. **A pinned tool.** Hivra fetches one no-mistakes release asset for this platform at a version pinned in the repo,
   checks its SHA-256 against a pinned value, and keeps it in `<data>/tools/no-mistakes/<version>/`. No `curl | sh`,
   no self-update. A version bump is a reviewed commit that changes both the version and the checksums.
2. **Its own home.** `NM_HOME` is a short folder in Hivra's data folder (for example `<data>/nm`), so it never
   touches a no-mistakes the person installed themselves. Check the socket path against the limit (103 bytes on
   macOS) and say plainly if it is too long. Hivra writes that home's `config.yaml`: the pipeline agent is the
   engine the crew used (claude or grok), with the other as fallback.
3. **No login item.** Hivra must not install a LaunchAgent, systemd unit or scheduled task for the daemon without
   Ash's OK (the same rule as ships, r50). Start it as a detached process that Hivra stops when it quits, if
   no-mistakes allows that. If it doesn't, stop and report in the PR rather than installing a service.
4. **Per project, off by default.** Project settings: "Check work before it goes to GitHub". Turning it on runs
   `no-mistakes init` for that checkout (it adds a `no-mistakes` remote) and shows what it did. Turning it off
   removes that remote.
5. **The crew's delivery.** With the gate on, a crew that would push and open a PR instead runs
   `no-mistakes axi run --yes` from its worktree, with the brief's goal and definition of done as `--intent`, and
   the PR title and body the crew wrote. Mechanical fixes go through by themselves.
6. **Judgment calls reach the person.** A run parked on an ask-user finding becomes one decision (WP-14) on the
   task (WP-70, "needs you"). It shows the finding in plain words with approve, fix or skip, and the answer goes
   back through `axi respond`. Nothing is answered for the person.
7. **Visible.** While the gate runs, the task card says what it is doing ("checking: tests"), from `axi status`.
   Gate started, parked, passed and PR opened each go to the activity log (WP-78). The finished PR links back to
   the task.
8. **One watcher per PR.** A PR that came through the gate has its CI repaired by no-mistakes. Hivra's PR watch
   still shows its state but doesn't dispatch its own fix crew for it.
9. **One check per job, not three** (Ash, 4 Nov: "will it cause bloat?"):
   - pstack's skills guide a worker while it builds;
   - WP-40's gates decide whether the work is done (diff, the project's checks, committed, the verdict);
   - no-mistakes is the single review before GitHub.

   With the gate on, the crew does not also run a separate review round before delivery, and WP-40 doesn't run the
   project's checks a second time when the gate's Test step runs the same command. Record which layer ran which
   check on the task, so nothing is silently skipped.
10. **Hivra's own repo first.** Add the repo config so the gate runs `npm run check`. That is the first project to use
   it.
11. **Dev copies** use `NM_HOME` inside the slot's data folder and never push to a real remote. Tests use a local
    bare repo as `origin` and a stand-in for the PR step (`MONOCODE_NO_MISTAKES`, read by dev copies only, like
    `MONOCODE_PR_WATCH_GH`).

Credit no-mistakes (MIT) in credits.json. If a later change bundles its binary in the app, add a `NOTICE` entry.

## Done when

- [ ] Tests with the stand-in:
  - the gate is off by default;
  - on, a finished crew runs `axi run` with its intent, and nothing is pushed directly;
  - a parked finding becomes exactly one decision, and approve, fix and skip each reach `axi respond`;
  - a passed run links its PR to the task;
  - the checksum is checked, and a mismatch refuses to install;
  - the socket-length check;
  - a dev copy never names a real remote;
  - with the gate on, the project's checks run once per delivery, and the task records which layer ran them.
- [ ] Windows: the pinned asset and checksum for each platform, and the same tests on the Windows runner.
- [ ] `npm run check` passes. Dev-copy check on a test repo: a deliberate lint slip is fixed by the gate, and a
      judgment call reaches the task card.
