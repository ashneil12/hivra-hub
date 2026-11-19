//! The pull request's head, checked out where the owner will fix it, before the wake reaches it.
//!
//! - A **registered worktree** is fast-forwarded to the pull request's head (`git fetch <remote> pull/<n>/head`, then
//!   `git merge --ff-only`), only when it is clean (tracked files), on the pull request's branch, on `mc/pr-<n>` or
//!   detached. Otherwise it is left exactly as it is and the wake says why.
//! - With none registered, a worktree `mc/pr-<n>` is made from a checkout of the repository among the owner's projects
//!   (MonoCode's usual worktree folder, without the project's setup), the first time a wake needs a fix.
//!
//! Only `fetch`, `merge --ff-only` and `worktree add` run: nothing is reset, rebased, pushed or deleted, and the
//! project's setup never runs in a worktree made here (the checkout holds the pull request's code). A pull request from a
//! fork is never checked out at all (mod.rs `apply`): anyone can open one and comment to wake the owner.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where a wake's checkout stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ready {
        path: String,
        head: String,
        /// Where it was before (the same as `head` when it was already there).
        from: Option<String>,
        /// MonoCode made this worktree for the wake.
        created: bool,
        /// A line about the project's setup in a new worktree.
        setup: Option<String>,
    },
    Left {
        path: String,
        reason: String,
    },
    Skipped(String),
    /// The pull request's head is in another repository (a fork, `None` when GitHub no longer shows it): its code is
    /// whoever opened it, so nothing is checked out.
    Fork(Option<String>),
}

/// What to check out.
pub struct Plan<'a> {
    pub repo: &'a str,
    pub number: u64,
    pub head_ref: &'a str,
    pub head_sha: &'a str,
    /// The registered worktree.
    pub worktree: Option<&'a Path>,
    /// A checkout of the repository to make `mc/pr-<n>` from.
    pub repo_root: Option<&'a Path>,
    /// Make `mc/pr-<n>` when nothing is registered (a wake that needs a fix).
    pub create: bool,
    /// How long the fetch from GitHub may take ([`FETCH_TIMEOUT`]).
    pub fetch_timeout: Duration,
}

/// A fetch that hasn't finished by then is stopped: one stalled remote must not hold up every other watch.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Making a worktree (worktrees.rs, with the project's setup), as a seam for tests.
pub trait Maker {
    /// Returns the new worktree's path and a line about its setup.
    fn make(
        &self,
        root: &Path,
        branch: &str,
        commit: &str,
    ) -> Result<(PathBuf, Option<String>), String>;
}

/// Local git work (status, merge, rev-parse) gets this long; the fetch from GitHub has its own [`FETCH_TIMEOUT`].
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_within(dir, args, GIT_TIMEOUT)
}

/// git in `dir`, stopped (with what it started) if it hasn't finished within `timeout`.
fn git_within(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    crate::git_cmd::ensure_contained(dir)?;
    let mut command = crate::git_cmd::git();
    crate::hide_window_console(&mut command);
    command.arg("-C").arg(dir);
    crate::git_cmd::extend_readonly(&mut command, args);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("PATH", crate::harness::cached_gui_search_path());
    let what = args.first().unwrap_or(&"");
    let ran = super::bounded::run(command, timeout).map_err(|failed| match failed {
        super::bounded::Failed::TimedOut => format!(
            "git {what} didn't finish within {}, so it was stopped",
            super::bounded::words(timeout)
        ),
        super::bounded::Failed::NotFound => "git isn't installed".to_string(),
        super::bounded::Failed::Other(error) => error,
    })?;
    if ran.status.success() {
        Ok(ran.stdout.trim().to_string())
    } else {
        let stderr = ran.stderr.trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {what} failed")
        } else {
            stderr.chars().take(400).collect()
        })
    }
}

/// `owner/name` of a GitHub remote URL (https, ssh or scp form), lowercased.
pub fn github_repo_of(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("git://github.com/"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .then(|| format!("{owner}/{name}").to_ascii_lowercase())
}

/// The remote of `dir` that points at `repo`, by the URL as configured (not as `insteadOf` rewrites it).
pub fn remote_for(dir: &Path, repo: &str) -> Option<String> {
    let want = repo.to_ascii_lowercase();
    let config = git(dir, &["config", "--get-regexp", r"^remote\..*\.url$"]).ok()?;
    config.lines().find_map(|line| {
        let (key, url) = line.split_once(' ')?;
        let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
        (github_repo_of(url).as_deref() == Some(want.as_str())).then(|| name.to_string())
    })
}

/// Whether `dir` is a git checkout.
pub fn is_git(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|v| v == "true")
}

/// Whether `dir` is a git checkout with a remote for `repo`.
pub fn is_checkout_of(dir: &Path, repo: &str) -> bool {
    is_git(dir) && remote_for(dir, repo).is_some()
}

/// Fetch the pull request's head into FETCH_HEAD: from the repository's remote, or by its URL when the checkout has
/// none for it (a fork's clone). Returns the fetched commit.
fn fetch_head(dir: &Path, repo: &str, number: u64, timeout: Duration) -> Result<String, String> {
    let refspec = format!("refs/pull/{number}/head");
    let source = remote_for(dir, repo).unwrap_or_else(|| format!("https://github.com/{repo}.git"));
    git_within(
        dir,
        &["fetch", "--no-tags", "--quiet", &source, &refspec],
        timeout,
    )?;
    git(dir, &["rev-parse", "FETCH_HEAD^{commit}"])
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Bring `dir` to the pull request's head, fast-forward only.
fn sync(dir: &Path, plan: &Plan, ours: bool) -> Outcome {
    let path = display(dir);
    let left = |reason: String| Outcome::Left {
        path: path.clone(),
        reason,
    };
    if !dir.is_dir() {
        return Outcome::Skipped(format!("{path} no longer exists"));
    }
    let head = match git(dir, &["rev-parse", "HEAD"]) {
        Ok(head) => head,
        Err(error) => return left(format!("it is not a git checkout ({error})")),
    };
    let branch = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let mine = format!("mc/pr-{}", plan.number);
    if let Some(branch) = branch.as_deref() {
        if branch != plan.head_ref && branch != mine && !ours {
            // The pull request's branch name is its author's words: the wake frames it (wake.rs), never this reason.
            return left(format!(
                "it is on branch {branch}, not the pull request's branch"
            ));
        }
    }
    match git(dir, &["status", "--porcelain", "--untracked-files=no"]) {
        Ok(status) if !status.is_empty() => {
            return left(format!(
                "it has uncommitted changes (HEAD {}); commit or stash them, then fetch pull/{}/head yourself",
                &head[..head.len().min(7)],
                plan.number
            ))
        }
        Err(error) => return left(error),
        _ => {}
    }
    let target = match fetch_head(dir, plan.repo, plan.number, plan.fetch_timeout) {
        Ok(target) => target,
        Err(error) => {
            return left(format!(
                "fetching pull/{}/head failed: {error}",
                plan.number
            ))
        }
    };
    if target == head {
        return Outcome::Ready {
            path,
            head,
            from: None,
            created: false,
            setup: None,
        };
    }
    if git(dir, &["merge-base", "--is-ancestor", &head, &target]).is_err() {
        let ahead = git(dir, &["merge-base", "--is-ancestor", &target, &head]).is_ok();
        return left(if ahead {
            format!(
                "it has commits the pull request doesn't (HEAD {}); push them, or the wake's news is about an older head",
                &head[..head.len().min(7)]
            )
        } else {
            format!(
                "it has diverged from the pull request's head {} (HEAD {}); reconcile it yourself",
                &target[..target.len().min(7)],
                &head[..head.len().min(7)]
            )
        });
    }
    match git(dir, &["merge", "--ff-only", "--quiet", &target]) {
        Ok(_) => Outcome::Ready {
            path,
            head: target,
            from: Some(head),
            created: false,
            setup: None,
        },
        Err(error) => left(format!("the fast-forward failed: {error}")),
    }
}

/// Make `mc/pr-<n>` from a checkout of the repository at the pull request's head, or reuse one made before.
fn make(root: &Path, plan: &Plan, maker: &dyn Maker) -> Result<Outcome, String> {
    let branch = format!("mc/pr-{}", plan.number);
    let existing = crate::worktrees::list(root)?
        .into_iter()
        .find(|tree| tree.branch.as_deref() == Some(branch.as_str()));
    if let Some(tree) = existing {
        return Ok(sync(Path::new(&tree.path), plan, true));
    }
    let commit = fetch_head(root, plan.repo, plan.number, plan.fetch_timeout)?;
    let (path, setup) = maker.make(root, &branch, &commit)?;
    Ok(Outcome::Ready {
        path: display(&path),
        head: commit,
        from: None,
        created: true,
        setup,
    })
}

/// Get the pull request's head ready for the owner, or say why not. `worktree` comes back when MonoCode made one, so
/// the watch remembers it.
pub fn prepare(plan: &Plan, maker: &dyn Maker) -> (Outcome, Option<String>) {
    if plan.head_sha.is_empty() {
        return (Outcome::Skipped("GitHub gave no head commit".into()), None);
    }
    if let Some(worktree) = plan.worktree {
        return (sync(worktree, plan, false), None);
    }
    let Some(root) = plan.repo_root else {
        return (
            Outcome::Skipped(format!(
                "no checkout of {} among your projects; pass worktree to pr_watch to have one kept at the head",
                plan.repo
            )),
            None,
        );
    };
    if !plan.create {
        return (Outcome::Skipped("nothing to fix".into()), None);
    }
    match make(root, plan, maker) {
        Ok(outcome) => {
            let made = match &outcome {
                Outcome::Ready { path, .. } | Outcome::Left { path, .. } => Some(path.clone()),
                Outcome::Skipped(_) | Outcome::Fork(_) => None,
            };
            (outcome, made)
        }
        Err(error) => (
            Outcome::Skipped(format!("making a worktree for it failed: {error}")),
            None,
        ),
    }
}

/// What the wake says about the project's setup in a worktree made for it.
pub const SETUP_NOT_RUN: &str = "The project's setup was not run: the checkout holds the pull request's code, so MonoCode runs nothing from it. Read the change before you run its setup, tests or build.";

/// worktrees.rs's own `git worktree add`, then `setup` (worktrees.rs `with_setup`) told never to run the project's
/// setup: the checkout is at the pull request's head, and its package.json, build.rs or setup script is whoever wrote it.
/// The files `.worktreeinclude` names are not copied in either, for the same reason: they are the project's secrets,
/// and the code in this checkout could read them.
fn make_worktree(
    root: &Path,
    branch: &str,
    commit: &str,
    setup: impl FnOnce(crate::worktrees::Worktree, Option<bool>) -> crate::worktrees::Worktree,
) -> Result<(PathBuf, Option<String>), String> {
    let tree = crate::worktrees::create_without_include(root, branch, commit, false)?;
    let tree = setup(tree, Some(false));
    Ok((PathBuf::from(tree.path), Some(SETUP_NOT_RUN.to_string())))
}

/// The app's worktree maker.
pub struct AppMaker(pub tauri::AppHandle);

impl Maker for AppMaker {
    fn make(
        &self,
        root: &Path,
        branch: &str,
        commit: &str,
    ) -> Result<(PathBuf, Option<String>), String> {
        make_worktree(root, branch, commit, |tree, run_setup| {
            crate::worktrees::with_setup(&self.0, tree, run_setup)
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A bare "GitHub" with a pull request ref, and a clone whose `origin` says github.com but fetches from the bare
    /// one (`insteadOf`), as a real clone would.
    pub struct Repos {
        pub dir: PathBuf,
        pub bare: PathBuf,
        pub clone: PathBuf,
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    pub fn commit(dir: &Path, file: &str, text: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        run(dir, &["add", file]);
        run(
            dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                text,
            ],
        );
        run(dir, &["rev-parse", "HEAD"])
    }

    impl Repos {
        pub fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("pr-watch-{tag}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            let bare = dir.join("github.git");
            let seed = dir.join("seed");
            std::fs::create_dir_all(&seed).unwrap();
            run(&seed, &["init", "-q", "-b", "main"]);
            commit(&seed, "a.txt", "one");
            run(
                &dir,
                &[
                    "clone",
                    "-q",
                    "--bare",
                    seed.to_str().unwrap(),
                    bare.to_str().unwrap(),
                ],
            );
            let clone = dir.join("clone");
            run(
                &dir,
                &[
                    "clone",
                    "-q",
                    bare.to_str().unwrap(),
                    clone.to_str().unwrap(),
                ],
            );
            run(
                &clone,
                &[
                    "remote",
                    "set-url",
                    "origin",
                    "https://github.com/Owner/Repo.git",
                ],
            );
            let rewrite = format!("url.{}.insteadOf", bare.to_str().unwrap());
            run(
                &clone,
                &["config", &rewrite, "https://github.com/Owner/Repo.git"],
            );
            Self { dir, bare, clone }
        }

        /// Push a commit on `branch` (from the seed's history) and point `refs/pull/<n>/head` at it.
        pub fn push_pr(&self, number: u64, branch: &str, file: &str, text: &str) -> String {
            let work = self
                .dir
                .join(format!("work-{}", uuid::Uuid::new_v4().simple()));
            run(
                &self.dir,
                &[
                    "clone",
                    "-q",
                    self.bare.to_str().unwrap(),
                    work.to_str().unwrap(),
                ],
            );
            if run(&work, &["branch", "-r"]).contains(&format!("origin/{branch}")) {
                run(&work, &["checkout", "-q", branch]);
            } else {
                run(&work, &["checkout", "-q", "-b", branch]);
            }
            let sha = commit(&work, file, text);
            run(
                &work,
                &["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")],
            );
            run(
                &work,
                &[
                    "push",
                    "-q",
                    "origin",
                    &format!("HEAD:refs/pull/{number}/head"),
                ],
            );
            sha
        }
    }

    impl Drop for Repos {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    struct NoMaker;
    impl Maker for NoMaker {
        fn make(&self, _: &Path, _: &str, _: &str) -> Result<(PathBuf, Option<String>), String> {
            Err("not in this test".into())
        }
    }

    /// worktrees.rs's create, without an app for the setup.
    pub struct PlainMaker;
    impl Maker for PlainMaker {
        fn make(
            &self,
            root: &Path,
            branch: &str,
            commit: &str,
        ) -> Result<(PathBuf, Option<String>), String> {
            let tree = crate::worktrees::create_without_include(root, branch, commit, false)?;
            Ok((PathBuf::from(tree.path), None))
        }
    }

    fn plan<'a>(repos: &'a Repos, head: &'a str, worktree: Option<&'a Path>) -> Plan<'a> {
        Plan {
            repo: "owner/repo",
            number: 7,
            head_ref: "fix",
            head_sha: head,
            worktree,
            repo_root: Some(&repos.clone),
            create: true,
            fetch_timeout: FETCH_TIMEOUT,
        }
    }

    #[test]
    fn remote_urls_name_their_repository() {
        for url in [
            "https://github.com/Owner/Repo.git",
            "git@github.com:owner/repo",
            "ssh://git@github.com/owner/repo.git",
            "https://github.com/owner/repo/",
        ] {
            assert_eq!(github_repo_of(url).as_deref(), Some("owner/repo"), "{url}");
        }
        assert_eq!(github_repo_of("https://gitlab.com/owner/repo"), None);
        assert_eq!(github_repo_of("/tmp/github.git"), None);
    }

    #[test]
    fn a_registered_worktree_on_the_branch_is_fast_forwarded_to_the_head() {
        let repos = Repos::new("ff");
        let first = repos.push_pr(7, "fix", "b.txt", "two");
        run(&repos.clone, &["fetch", "-q", "origin"]);
        run(&repos.clone, &["checkout", "-q", "-b", "fix", &first]);
        assert!(is_checkout_of(&repos.clone, "owner/repo"));
        let second = repos.push_pr(7, "fix", "c.txt", "three");
        let (outcome, made) = prepare(&plan(&repos, &second, Some(&repos.clone)), &NoMaker);
        assert_eq!(made, None);
        assert_eq!(
            outcome,
            Outcome::Ready {
                path: display(&repos.clone),
                head: second.clone(),
                from: Some(first),
                created: false,
                setup: None
            }
        );
        assert_eq!(run(&repos.clone, &["rev-parse", "HEAD"]), second);
        // Already there: nothing to do.
        let (again, _) = prepare(&plan(&repos, &second, Some(&repos.clone)), &NoMaker);
        assert!(matches!(again, Outcome::Ready { from: None, .. }));
    }

    #[test]
    fn a_dirty_or_foreign_or_ahead_worktree_is_left_alone() {
        let repos = Repos::new("left");
        let head = repos.push_pr(7, "fix", "b.txt", "two");
        // On another branch.
        let (outcome, _) = prepare(&plan(&repos, &head, Some(&repos.clone)), &NoMaker);
        assert!(
            matches!(&outcome, Outcome::Left { reason, .. } if reason.contains("on branch main")),
            "{outcome:?}"
        );
        // On the branch, with uncommitted changes.
        run(&repos.clone, &["fetch", "-q", "origin"]);
        run(
            &repos.clone,
            &["checkout", "-q", "-b", "fix", "origin/main"],
        );
        std::fs::write(repos.clone.join("a.txt"), "edited").unwrap();
        let before = run(&repos.clone, &["rev-parse", "HEAD"]);
        let (outcome, _) = prepare(&plan(&repos, &head, Some(&repos.clone)), &NoMaker);
        assert!(
            matches!(&outcome, Outcome::Left { reason, .. } if reason.contains("uncommitted")),
            "{outcome:?}"
        );
        assert_eq!(run(&repos.clone, &["rev-parse", "HEAD"]), before);
        assert_eq!(
            std::fs::read_to_string(repos.clone.join("a.txt")).unwrap(),
            "edited"
        );
        // Clean but with a local commit the pull request lacks: diverged, never reset.
        run(&repos.clone, &["checkout", "-q", "a.txt"]);
        let local = commit(&repos.clone, "d.txt", "local");
        let (outcome, _) = prepare(&plan(&repos, &head, Some(&repos.clone)), &NoMaker);
        assert!(
            matches!(&outcome, Outcome::Left { reason, .. } if reason.contains("diverged")),
            "{outcome:?}"
        );
        assert_eq!(run(&repos.clone, &["rev-parse", "HEAD"]), local);
    }

    #[test]
    fn without_a_worktree_one_is_made_at_the_head_and_reused() {
        let repos = Repos::new("make");
        let head = repos.push_pr(7, "fix", "b.txt", "two");
        let (outcome, made) = prepare(&plan(&repos, &head, None), &PlainMaker);
        let Outcome::Ready {
            path,
            head: at,
            created: true,
            ..
        } = &outcome
        else {
            panic!("{outcome:?}")
        };
        assert_eq!(at, &head);
        assert_eq!(made.as_deref(), Some(path.as_str()));
        assert_eq!(run(Path::new(path), &["rev-parse", "HEAD"]), head);
        assert_eq!(
            run(Path::new(path), &["symbolic-ref", "--short", "HEAD"]),
            "mc/pr-7"
        );
        // The next wake syncs the same worktree (registered now) to a newer head.
        let newer = repos.push_pr(7, "fix", "c.txt", "three");
        let (outcome, _) = prepare(&plan(&repos, &newer, Some(Path::new(path))), &PlainMaker);
        assert!(
            matches!(&outcome, Outcome::Ready { head, created: false, .. } if head == &newer),
            "{outcome:?}"
        );
        // Asked again with nothing registered, the one made before is found and reused.
        let (outcome, _) = prepare(&plan(&repos, &newer, None), &PlainMaker);
        assert!(
            matches!(&outcome, Outcome::Ready { created: false, .. }),
            "{outcome:?}"
        );
        let _ = std::fs::remove_dir_all(repos.dir.join("clone-worktrees"));
    }

    /// The app's maker with the setup step recorded instead of started (it needs a running app).
    struct SetupSpy(std::sync::Mutex<Vec<Option<bool>>>);
    impl Maker for SetupSpy {
        fn make(
            &self,
            root: &Path,
            branch: &str,
            commit: &str,
        ) -> Result<(PathBuf, Option<String>), String> {
            make_worktree(root, branch, commit, |mut tree, run_setup| {
                self.0.lock().unwrap().push(run_setup);
                if run_setup != Some(false) {
                    // What `with_setup` does: the project's setup starts in the new worktree.
                    tree.setup = Some(crate::project_actions::WorktreeSetup {
                        action_id: Some("setup".into()),
                        name: Some("Setup".into()),
                        command: Some("npm ci".into()),
                        hold: true,
                        run: None,
                        skipped: Some("the spy stands in for it".into()),
                    });
                }
                tree
            })
        }
    }

    #[test]
    fn a_worktree_made_for_a_wake_never_runs_the_projects_setup() {
        let repos = Repos::new("nosetup");
        let head = repos.push_pr(7, "fix", "b.txt", "two");
        let spy = SetupSpy(Default::default());
        let (outcome, made) = prepare(&plan(&repos, &head, None), &spy);
        assert!(made.is_some(), "{outcome:?}");
        // The pull request's package.json, build.rs or setup script is whoever opened it: nothing in it runs.
        assert_eq!(*spy.0.lock().unwrap(), vec![Some(false)]);
        let Outcome::Ready { setup, .. } = &outcome else {
            panic!("{outcome:?}")
        };
        let setup = setup.as_deref().unwrap_or("");
        assert!(setup.contains("setup was not run"), "{setup}");
        let _ = std::fs::remove_dir_all(repos.dir.join("clone-worktrees"));
    }

    #[test]
    fn a_worktree_made_for_a_wake_gets_none_of_the_files_worktreeinclude_names() {
        let repos = Repos::new("noinclude");
        // The project ignores `.env` and names it in `.worktreeinclude`, so a worktree the
        // person makes would get it. The pull request's code could read it, so this one does not.
        commit(&repos.clone, ".gitignore", ".env\n");
        std::fs::write(repos.clone.join(".env"), "SECRET-VALUE-do-not-leak\n").unwrap();
        std::fs::write(repos.clone.join(".worktreeinclude"), ".env\n").unwrap();
        let person = crate::worktrees::create(&repos.clone, "mc/by-hand", "HEAD", false).unwrap();
        assert!(Path::new(&person.path).join(".env").is_file());

        let head = repos.push_pr(7, "fix", "b.txt", "two");
        let spy = SetupSpy(Default::default());
        let (outcome, made) = prepare(&plan(&repos, &head, None), &spy);
        let path = made.unwrap_or_else(|| panic!("{outcome:?}"));
        assert!(!Path::new(&path).join(".env").exists(), "{path}");
        let _ = std::fs::remove_dir_all(repos.dir.join("clone-worktrees"));
    }

    #[test]
    fn a_stalled_fetch_is_cut_off_and_the_checkout_left_as_it_was() {
        let repos = Repos::new("stall");
        let head = repos.push_pr(7, "fix", "b.txt", "two");
        run(&repos.clone, &["fetch", "-q", "origin"]);
        run(
            &repos.clone,
            &["checkout", "-q", "-b", "fix", "origin/main"],
        );
        let before = run(&repos.clone, &["rev-parse", "HEAD"]);
        // GitHub stops answering: the remote is a program that never speaks git's protocol.
        let rewrite = format!("url.{}.insteadOf", repos.bare.to_str().unwrap());
        run(&repos.clone, &["config", "--unset", &rewrite]);
        run(&repos.clone, &["config", "protocol.ext.allow", "always"]);
        run(
            &repos.clone,
            &[
                "config",
                "url.ext::sleep 20.insteadOf",
                "https://github.com/Owner/Repo.git",
            ],
        );
        let started = std::time::Instant::now();
        let stalled = Plan {
            fetch_timeout: std::time::Duration::from_secs(2),
            ..plan(&repos, &head, Some(&repos.clone))
        };
        let (outcome, _) = prepare(&stalled, &NoMaker);
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_secs(10),
            "the fetch held the watch for {took:?}"
        );
        assert!(
            matches!(&outcome, Outcome::Left { reason, .. } if reason.contains("didn't finish within 2 s")),
            "{outcome:?}"
        );
        assert_eq!(run(&repos.clone, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn nothing_is_made_for_news_that_needs_no_fix() {
        let repos = Repos::new("nofix");
        let head = repos.push_pr(7, "fix", "b.txt", "two");
        let quiet = Plan {
            create: false,
            ..plan(&repos, &head, None)
        };
        assert!(matches!(prepare(&quiet, &NoMaker).0, Outcome::Skipped(_)));
        let nowhere = Plan {
            repo_root: None,
            ..plan(&repos, &head, None)
        };
        assert!(
            matches!(prepare(&nowhere, &NoMaker).0, Outcome::Skipped(reason) if reason.contains("no checkout of owner/repo"))
        );
    }
}
