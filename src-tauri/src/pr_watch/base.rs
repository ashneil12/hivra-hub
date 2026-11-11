//! The base branch under a watched pull request (WP-202): when main moved, whether what it changed touches the pull
//! request's own files, how far behind main the branch is, and which main the pull request's checks last ran on.
//!
//! Every fact comes from GitHub through a `get` (a REST path to its JSON), so the sweep and the merge gate read the
//! same way. Nothing here writes to GitHub, and nothing is stored as "green": the merge gate asks GitHub, at merge
//! time, which main the head's checks ran on. A missing or unreadable fact holds the merge rather than passing it.

use super::eval::{Change, Memo};
use super::github::PrRead;

/// GitHub's compare answer lists at most this many files; a list this long may be cut short.
pub const COMPARE_FILE_CAP: usize = 300;
/// One page of a pull request's files: a page this full may be cut short.
pub const PULL_FILES_PAGE: usize = 100;
/// Remembered base wakes per watch (a head and base each add one key).
const TOLD_BASE_MAX: usize = 20;
/// How long a watch waits before it asks GitHub again after a failed base read (rate limits, the network).
pub const RETRY_AFTER: i64 = 10 * 60_000;

/// The `get` seam: a REST path (relative to the API root) to its JSON answer.
pub type Get<'a> = &'a dyn Fn(&str) -> Result<String, String>;

/// Files that differ between two commits, from `compare`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compare {
    pub files: Vec<String>,
    pub cut_short: bool,
    /// Commits the second side has that the first lacks. For `compare(head...base)` that is how many commits main has
    /// that the branch lacks (WP-202 H4: `behind_by` counts the branch's own commits).
    pub ahead_by: u32,
    /// GitHub's word for the pair: ahead, behind, identical, or diverged (the first is not an ancestor of the second).
    pub status: String,
}

/// What main changed since the watch last saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Moved {
    pub files: Vec<String>,
    pub cut_short: bool,
    /// Main was rewritten (force-pushed): nothing can say which files moved, so the move is unknown.
    pub diverged: bool,
}

/// What the network said this read, gathered before the database is held. `news` settles it onto the memo.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Main's move since the watch's base, when it moved and GitHub said which files.
    pub moved: Option<Moved>,
    /// The pull request's own files, for the head this read saw (cached on the memo per head).
    pub pr_files: Option<(Vec<String>, bool)>,
    /// How far behind main the head is (cached on the memo per head and base).
    pub behind: Option<u32>,
    /// A move, a file list or the behind count could not be read: the base is not advanced, and the watch waits
    /// `RETRY_AFTER` before asking again.
    pub unread: bool,
    /// Cache entries to store on the memo.
    pub cache_pr_files: Option<(String, Vec<String>, bool)>,
    pub cache_behind: Option<(String, String, u32)>,
}

/// The merge gate's view of one pull request against what it was checked on.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Touch {
    None,
    Named(Vec<String>),
    /// GitHub listed only part of one of the file lists: it may touch the pull request.
    Unknown,
}

// ---- parsing (pure) ------------------------------------------------------------------------------------------------

/// A compare answer: its files, and the commits the second side has that the first lacks.
pub fn parse_compare(json: &str) -> Result<Compare, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| "GitHub's compare answer was not JSON".to_string())?;
    let files = filenames(value.get("files"))?;
    let ahead_by = value
        .get("ahead_by")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(Compare {
        cut_short: files.len() >= COMPARE_FILE_CAP,
        files,
        ahead_by,
        status,
    })
}

/// A pull request's files (one page), and whether the page was full.
pub fn parse_pull_files(json: &str) -> Result<(Vec<String>, bool), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "GitHub's file list was not JSON".to_string())?;
    let files = filenames(Some(&value))?;
    let full = files.len() >= PULL_FILES_PAGE;
    Ok((files, full))
}

/// The filenames in a GitHub file list. A list that isn't a list is an error, not an empty answer.
fn filenames(value: Option<&serde_json::Value>) -> Result<Vec<String>, String> {
    let items = value
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "GitHub's file list is missing".to_string())?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let name = item
            .get("filename")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "a changed file has no name".to_string())?;
        out.push(name.to_string());
    }
    Ok(out)
}

/// The files both lists name, in the order of `moved`, each once.
pub fn overlap(moved: &[String], pr: &[String]) -> Vec<String> {
    let mut hits: Vec<String> = Vec::new();
    for file in moved {
        if pr.contains(file) && !hits.contains(file) {
            hits.push(file.clone());
        }
    }
    hits
}

/// Whether a moved list touches the pull request's files: named files, unknown when a list was cut short.
fn touch(moved: &Moved, pr: &(Vec<String>, bool)) -> Touch {
    let (files, pr_cut) = pr;
    if moved.files.is_empty() || files.is_empty() {
        return Touch::None;
    }
    let hits = overlap(&moved.files, files);
    if !hits.is_empty() {
        return Touch::Named(hits);
    }
    if moved.cut_short || *pr_cut {
        return Touch::Unknown;
    }
    Touch::None
}

// ---- reads ---------------------------------------------------------------------------------------------------------

/// A commit id as GitHub writes one: hex, 7 to 64 characters. Anything else never reaches a path.
fn is_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn compare(get: Get, repo: &str, from: &str, to: &str) -> Result<Compare, String> {
    if !is_sha(from) || !is_sha(to) {
        return Err("a commit id is not a commit id".into());
    }
    parse_compare(&get(&format!("repos/{repo}/compare/{from}...{to}"))?)
}

fn pull_files(get: Get, repo: &str, number: u64) -> Result<(Vec<String>, bool), String> {
    parse_pull_files(&get(&format!(
        "repos/{repo}/pulls/{number}/files?per_page={PULL_FILES_PAGE}"
    ))?)
}

/// The main commit each of the head's check runs ran on (their `pull_requests[].base.sha`), read from every page.
/// `Ok(None)`: no run says. `Err`: the runs disagree, or the list can't be read whole. Either way the merge waits.
pub fn checks_base(get: Get, repo: &str, head: &str) -> Result<Option<String>, String> {
    if !is_sha(head) {
        return Err("the head is not a commit id".into());
    }
    let paged = super::github::rest_pages(
        get,
        &format!("repos/{repo}/commits/{head}/check-runs"),
        "check_runs",
    )?;
    let mut bases: Vec<String> = Vec::new();
    for run in &paged.items {
        let Some(prs) = run
            .get("pull_requests")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for pr in prs {
            if let Some(sha) = pr.pointer("/base/sha").and_then(serde_json::Value::as_str) {
                if !bases.iter().any(|b| b == sha) {
                    bases.push(sha.to_string());
                }
            }
        }
    }
    match bases.len() {
        0 => Ok(None),
        1 => Ok(bases.pop()),
        _ => Err("the checks ran on more than one main".into()),
    }
}

/// Everything the network says for one open pull request this read: main's move, the pull request's files, how far
/// behind main the head is. Nothing is read for a read with no base, or for a watch whose state is stale (`stale`:
/// the baseline is taken without replaying old news).
pub fn facts(get: Get, repo: &str, number: u64, memo: &Memo, read: &PrRead, stale: bool) -> Facts {
    let mut facts = Facts::default();
    let (Some(head), Some(base)) = (read.detail.head_sha.as_deref(), read.base_tip.as_deref())
    else {
        return facts;
    };
    if stale {
        return facts;
    }
    let cached = match &memo.behind_at {
        Some((h, b, n)) if h == head && b == base => Some(*n),
        _ => None,
    };
    match cached {
        Some(n) => facts.behind = Some(n),
        None => match compare(get, repo, head, base) {
            Ok(c) => {
                facts.behind = Some(c.ahead_by);
                facts.cache_behind = Some((head.into(), base.into(), c.ahead_by));
            }
            Err(_) => facts.unread = true,
        },
    }
    let Some(old) = memo.base_sha.as_deref() else {
        return facts;
    };
    if old == base {
        return facts;
    }
    let c = match compare(get, repo, old, base) {
        Ok(c) => c,
        Err(_) => {
            facts.unread = true;
            return facts;
        }
    };
    if c.status == "diverged" {
        // Main was force-pushed: the files can't be listed, so the move counts as unknown.
        facts.moved = Some(Moved {
            files: Vec::new(),
            cut_short: true,
            diverged: true,
        });
        return facts;
    }
    let moved = Moved {
        files: c.files,
        cut_short: c.cut_short,
        diverged: false,
    };
    let pr = match &memo.pr_files {
        Some((h, files, cut)) if h == head => (files.clone(), *cut),
        _ => match pull_files(get, repo, number) {
            Ok((files, cut)) => {
                facts.cache_pr_files = Some((head.into(), files.clone(), cut));
                (files, cut)
            }
            Err(_) => {
                facts.unread = true;
                return facts;
            }
        },
    };
    facts.pr_files = Some(pr);
    facts.moved = Some(moved);
    facts
}

// ---- news (pure once the facts are read) ---------------------------------------------------------------------------

/// The base news for this read, and the memo it leaves behind. `memo` is the memo the read's own evaluation produced
/// (it carries the watch's base fields). `conflict_told` says the read already reported a conflict.
pub fn news(memo: &mut Memo, read: &PrRead, facts: &Facts, conflict_told: bool) -> Vec<Change> {
    let mut out = Vec::new();
    if let Some(pr) = &facts.cache_pr_files {
        memo.pr_files = Some(pr.clone());
    }
    if let Some(behind) = &facts.cache_behind {
        memo.behind_at = Some(behind.clone());
    }
    let (Some(head), Some(base)) = (read.detail.head_sha.clone(), read.base_tip.clone()) else {
        return out;
    };
    if memo.base_sha.as_deref() != Some(base.as_str()) {
        let known = memo.base_sha.is_some();
        match (known, &facts.moved, facts.unread) {
            // A watch from before the base was read: record it, tell nothing.
            (false, _, _) => memo.base_sha = Some(base.clone()),
            // Main was rewritten: unknown, so it is said, and the new base is recorded.
            (true, Some(moved), false) if moved.diverged => {
                out.push(Change::BaseMoved {
                    to: base.clone(),
                    files: Vec::new(),
                    cut_short: true,
                });
                memo.base_sha = Some(base.clone());
            }
            // Judged: main moved, and the files were read.
            (true, Some(moved), false) => {
                if let Some(pr) = &facts.pr_files {
                    match touch(moved, pr) {
                        Touch::Named(files) => out.push(Change::BaseMoved {
                            to: base.clone(),
                            files,
                            cut_short: false,
                        }),
                        Touch::Unknown => out.push(Change::BaseMoved {
                            to: base.clone(),
                            files: Vec::new(),
                            cut_short: true,
                        }),
                        Touch::None => {}
                    }
                    memo.base_sha = Some(base.clone());
                }
            }
            // Not judged: keep the old base, so the next read asks again.
            _ => {}
        }
    }
    if read.merge_state.as_deref() == Some("BEHIND") {
        let key = format!("behind {head} {base}");
        if !memo.told_base.contains(&key) {
            out.push(Change::Behind {
                commits: facts.behind,
            });
            tell(memo, key);
        }
    }
    if read.merge_state.as_deref() == Some("DIRTY") && !conflict_told {
        let key = format!("dirty {head} {base}");
        if !memo.told_base.contains(&key) {
            out.push(Change::Conflicting);
            tell(memo, key);
        }
    }
    out
}

fn tell(memo: &mut Memo, key: String) {
    memo.told_base.push(key);
    if memo.told_base.len() > TOLD_BASE_MAX {
        let extra = memo.told_base.len() - TOLD_BASE_MAX;
        memo.told_base.drain(..extra);
    }
}

/// A stale watch's baseline: main's current base is taken as seen, and a BEHIND or DIRTY state the head already has is
/// marked told. The told keys already kept are not cleared, so a replay can't re-announce them.
pub fn settle_stale(memo: &mut Memo, read: &PrRead) {
    memo.base_sha = read.base_tip.clone();
    if let (Some(head), Some(base)) = (read.detail.head_sha.as_deref(), read.base_tip.as_deref()) {
        let key = match read.merge_state.as_deref() {
            Some("BEHIND") => format!("behind {head} {base}"),
            Some("DIRTY") => format!("dirty {head} {base}"),
            _ => return,
        };
        if !memo.told_base.contains(&key) {
            tell(memo, key);
        }
    }
}

// ---- the merge gate -------------------------------------------------------------------------------------------------

/// The merge gate's base check (WP-202), read from GitHub at merge time and never from the database. `Some(reason)`
/// holds the merge. It holds when main moved since the main the head's checks ran on and what it changed touches this
/// pull request, and whenever the answer is unknown: no base, no checks that say which main they ran on, a rewritten
/// main, or a read that failed. A move that misses the pull request's files holds nothing.
pub fn hold(get: Get, repo: &str, number: u64, head: &str, read: &PrRead) -> Option<String> {
    let pr = format!("{repo}#{number}");
    let Some(base) = read.base_tip.as_deref() else {
        return Some(format!(
            "{pr}'s base branch couldn't be read, so it waits. Try again."
        ));
    };
    let green = match checks_base(get, repo, head) {
        Ok(Some(sha)) => sha,
        Ok(None) => {
            return Some(format!(
                "{pr}'s checks don't say which main they ran on, so it waits for a run on the current main."
            ))
        }
        Err(error) => return Some(format!("{pr}'s checks couldn't be checked ({error}), so it waits. Try again.")),
    };
    if green == base {
        return None;
    }
    let moved = match compare(get, repo, &green, base) {
        Ok(c) if c.status == "diverged" => {
            return Some(format!(
                "main was rewritten since {pr}'s checks ran, so it waits for a run on the new main."
            ))
        }
        Ok(c) => Moved {
            files: c.files,
            cut_short: c.cut_short,
            diverged: false,
        },
        Err(error) => {
            return Some(format!(
                "{pr} couldn't be checked against main's changes since its checks ran ({error}), so it waits. Try again."
            ))
        }
    };
    let pr_files = match pull_files(get, repo, number) {
        Ok(files) => files,
        Err(error) => {
            return Some(format!(
                "{pr}'s changed files couldn't be read ({error}), so it waits. Try again."
            ))
        }
    };
    match touch(&moved, &pr_files) {
        Touch::None => None,
        Touch::Named(files) => Some(format!(
            "main moved since {pr}'s checks ran, and changed {}. Rebase onto main, push, and wait for green again.",
            files.join(", ")
        )),
        Touch::Unknown => Some(format!(
            "main moved since {pr}'s checks ran and changed more files than GitHub lists, so it may touch this pull request. Rebase onto main, push, and wait for green again."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::eval::{Detail, Mergeability};
    use super::super::github::PrState;
    use super::*;

    const H1: &str = "a1a1a1a";
    const B1: &str = "b1b1b1b";
    const B2: &str = "b2b2b2b";

    fn open(head: &str, base: &str, merge_state: Option<&str>) -> PrRead {
        PrRead {
            repo: "acme/web".into(),
            number: 7,
            url: String::new(),
            title: "Fix".into(),
            state: PrState::Open,
            draft: false,
            merge_sha: None,
            merged_at: None,
            head_ref: "work".into(),
            base_ref: "main".into(),
            base_tip: Some(base.into()),
            head_repo: Some("acme/web".into()),
            review_decision: None,
            labels: Vec::new(),
            detail: Detail {
                head_sha: Some(head.into()),
                checks: Vec::new(),
                mergeability: Mergeability::Mergeable,
                viewer: None,
                author: None,
            },
            remarks: Some(Vec::new()),
            rate: None,
            merge_state: merge_state.map(str::to_string),
            changed_files: None,
        }
    }

    /// Canned answers by path substring; anything else fails the way an unknown path does.
    fn canned(answers: Vec<(String, String)>) -> impl Fn(&str) -> Result<String, String> {
        move |path: &str| {
            answers
                .iter()
                .find(|(key, _)| path.contains(key.as_str()))
                .map(|(_, json)| json.clone())
                .ok_or_else(|| format!("no answer for {path}"))
        }
    }

    fn files_json(names: &[&str]) -> String {
        let items: Vec<serde_json::Value> = names
            .iter()
            .map(|n| serde_json::json!({ "filename": n }))
            .collect();
        serde_json::Value::Array(items).to_string()
    }

    /// A compare answer: `ahead` commits the second side has that the first lacks.
    fn compare_json(files: &[&str], ahead: u32) -> String {
        serde_json::json!({
            "status": if ahead > 0 { "ahead" } else { "identical" },
            "files": files.iter().map(|n| serde_json::json!({ "filename": n })).collect::<Vec<_>>(),
            "ahead_by": ahead,
            "behind_by": 0,
        })
        .to_string()
    }

    /// Check runs that ran on `base`, one page.
    fn checks_on(base: &str) -> String {
        serde_json::json!({
            "total_count": 1,
            "check_runs": [{ "name": "build", "status": "completed", "conclusion": "success",
                             "pull_requests": [{ "base": { "sha": base } }] }]
        })
        .to_string()
    }

    fn moved_key() -> String {
        format!("compare/{B1}...{B2}")
    }

    fn behind_key() -> String {
        format!("compare/{H1}...{B2}")
    }

    fn checks_key() -> String {
        format!("commits/{H1}/check-runs")
    }

    #[test]
    fn a_compare_lists_its_files_and_how_far_ahead_it_is() {
        let c = parse_compare(&compare_json(&["src/a.rs", "src/b.rs"], 3)).unwrap();
        assert_eq!(c.files, vec!["src/a.rs", "src/b.rs"]);
        assert_eq!((c.ahead_by, c.cut_short), (3, false));
        let full: Vec<&str> = std::iter::repeat_n("x.rs", COMPARE_FILE_CAP).collect();
        assert!(parse_compare(&compare_json(&full, 0)).unwrap().cut_short);
        assert!(parse_compare("not json").is_err());
        assert!(
            parse_compare(r#"{"ahead_by":1}"#).is_err(),
            "no file list is not an empty one"
        );
    }

    #[test]
    fn overlap_names_only_the_files_both_lists_have() {
        let moved = vec!["src/a.rs".to_string(), "docs/x.md".to_string()];
        let pr = vec![
            "docs/x.md".to_string(),
            "src/a.rs".to_string(),
            "src/a.rs".to_string(),
        ];
        assert_eq!(overlap(&moved, &pr), vec!["src/a.rs", "docs/x.md"]);
        assert!(overlap(&moved, &["README.md".to_string()]).is_empty());
    }

    #[test]
    fn a_base_move_touching_a_pull_request_file_is_news_once() {
        let get = canned(vec![
            (moved_key(), compare_json(&["src/lib.rs"], 0)),
            (behind_key(), compare_json(&[], 1)),
            (
                "pulls/7/files".into(),
                files_json(&["src/lib.rs", "README.md"]),
            ),
        ]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            ..Memo::default()
        };
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false),
            vec![Change::BaseMoved {
                to: B2.into(),
                files: vec!["src/lib.rs".into()],
                cut_short: false
            }]
        );
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
        // The same read again: the base is recorded, so nothing is news.
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(news(&mut memo, &read, &got, false).is_empty());
    }

    #[test]
    fn a_base_move_touching_other_files_is_not_news_but_moves_the_base() {
        let get = canned(vec![
            (moved_key(), compare_json(&["docs/notes.md"], 0)),
            (behind_key(), compare_json(&[], 1)),
            ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
        ]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            ..Memo::default()
        };
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(news(&mut memo, &read, &got, false).is_empty());
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
    }

    #[test]
    fn behind_is_news_once_per_head_and_base_and_counts_what_main_has_that_the_branch_lacks() {
        let get = canned(vec![(behind_key(), compare_json(&[], 3))]);
        let mut memo = Memo::default();
        let read = open(H1, B2, Some("BEHIND"));
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false),
            vec![Change::Behind { commits: Some(3) }]
        );
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(
            news(&mut memo, &read, &got, false).is_empty(),
            "a repeat poll fires nothing"
        );
        // A new head is a new key.
        let next = open("c3c3c3c", B2, Some("BEHIND"));
        let get = canned(vec![(
            format!("compare/c3c3c3c...{B2}"),
            compare_json(&[], 3),
        )]);
        let got = facts(&get, "acme/web", 7, &memo, &next, false);
        assert_eq!(
            news(&mut memo, &next, &got, false),
            vec![Change::Behind { commits: Some(3) }]
        );
    }

    #[test]
    fn r1_behind_counts_commits_main_has_that_the_head_lacks() {
        // The compare is head...base: its ahead_by is main's commits the branch lacks. Up to date is 0, not the
        // branch's own commits (which are behind_by on this compare).
        let get = canned(vec![(
            behind_key(),
            r#"{"status":"behind","ahead_by":0,"behind_by":4,"files":[]}"#.into(),
        )]);
        let got = facts(
            &get,
            "acme/web",
            7,
            &Memo::default(),
            &open(H1, B2, None),
            false,
        );
        assert_eq!(
            got.behind,
            Some(0),
            "a branch up to date with main is 0 commits behind it"
        );
    }

    #[test]
    fn dirty_is_news_once_unless_the_read_already_said_conflicting() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let read = open(H1, B2, Some("DIRTY"));
        let mut memo = Memo::default();
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false),
            vec![Change::Conflicting]
        );
        assert!(news(&mut memo, &read, &got, false).is_empty());
        let mut told = Memo::default();
        assert!(
            news(&mut told, &read, &got, true).is_empty(),
            "the conflict was already told"
        );
    }

    #[test]
    fn a_watch_with_no_base_recorded_records_it_and_tells_nothing() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let mut memo = Memo::default();
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(news(&mut memo, &read, &got, false).is_empty());
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
    }

    #[test]
    fn an_unreadable_move_keeps_the_old_base_so_the_next_read_asks_again() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            ..Memo::default()
        };
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(got.unread);
        assert!(news(&mut memo, &read, &got, false).is_empty());
        assert_eq!(
            memo.base_sha.as_deref(),
            Some(B1),
            "not advanced, so the move is asked for again"
        );
    }

    #[test]
    fn a_rewritten_main_is_said_as_an_unknown_move_and_the_base_moves_on() {
        let get = canned(vec![
            (
                moved_key(),
                r#"{"status":"diverged","ahead_by":2,"behind_by":2,"files":[]}"#.into(),
            ),
            (behind_key(), compare_json(&[], 1)),
        ]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            ..Memo::default()
        };
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false),
            vec![Change::BaseMoved {
                to: B2.into(),
                files: Vec::new(),
                cut_short: true
            }]
        );
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
    }

    #[test]
    fn a_stale_watch_reads_nothing_and_settles_on_the_current_base_without_replaying_told_news() {
        let get = canned(vec![]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            told_base: vec![format!("behind {H1} {B2}")],
            ..Memo::default()
        };
        let read = open(H1, B2, Some("BEHIND"));
        let got = facts(&get, "acme/web", 7, &memo, &read, true);
        assert_eq!(
            got,
            Facts::default(),
            "a stale watch asks GitHub for nothing"
        );
        settle_stale(&mut memo, &read);
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
        assert_eq!(
            memo.told_base,
            vec![format!("behind {H1} {B2}")],
            "a replay after a stale baseline must not announce BEHIND again"
        );
    }

    #[test]
    fn a_stale_baseline_marks_a_behind_head_as_told_so_it_is_not_announced_later() {
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            ..Memo::default()
        };
        settle_stale(&mut memo, &open(H1, B2, Some("BEHIND")));
        assert_eq!(memo.told_base, vec![format!("behind {H1} {B2}")]);
    }

    #[test]
    fn the_merge_hold_holds_a_move_over_the_files_since_the_checks_ran_on_the_old_main() {
        let get = canned(vec![
            (checks_key(), checks_on(B1)),
            (moved_key(), compare_json(&["src/lib.rs"], 0)),
            ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
        ]);
        let reason = hold(&get, "acme/web", 7, H1, &open(H1, B2, None)).expect("held");
        assert!(
            reason.contains("src/lib.rs") && reason.contains("Rebase onto main"),
            "{reason}"
        );
    }

    #[test]
    fn the_merge_hold_lets_a_move_that_misses_the_pull_request_through() {
        let get = canned(vec![
            (checks_key(), checks_on(B1)),
            (moved_key(), compare_json(&["docs/notes.md"], 0)),
            ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
        ]);
        assert_eq!(hold(&get, "acme/web", 7, H1, &open(H1, B2, None)), None);
    }

    #[test]
    fn the_merge_hold_lets_a_pull_request_through_when_its_checks_ran_on_the_current_main() {
        let get = canned(vec![(checks_key(), checks_on(B2))]);
        assert_eq!(hold(&get, "acme/web", 7, H1, &open(H1, B2, None)), None);
    }

    #[test]
    fn the_merge_hold_holds_when_the_checks_do_not_say_which_main_they_ran_on() {
        let none = canned(vec![(
            checks_key(),
            r#"{"total_count":1,"check_runs":[{"name":"build","status":"completed","conclusion":"success","pull_requests":[]}]}"#
                .into(),
        )]);
        assert!(
            hold(&none, "acme/web", 7, H1, &open(H1, B2, None)).is_some(),
            "unknown holds"
        );
        let split = canned(vec![(
            checks_key(),
            r#"{"total_count":2,"check_runs":[
                {"name":"a","pull_requests":[{"base":{"sha":"b1b1b1b"}}]},
                {"name":"b","pull_requests":[{"base":{"sha":"b9b9b9b"}}]}]}"#
                .into(),
        )]);
        assert!(
            hold(&split, "acme/web", 7, H1, &open(H1, B2, None)).is_some(),
            "runs on two mains hold"
        );
    }

    #[test]
    fn the_merge_hold_holds_when_the_base_branch_is_unknown_or_the_move_cannot_be_read() {
        let get = canned(vec![(checks_key(), checks_on(B1))]);
        let no_tip = PrRead {
            base_tip: None,
            ..open(H1, B2, None)
        };
        assert!(
            hold(&get, "acme/web", 7, H1, &no_tip).is_some(),
            "an unknown base holds"
        );
        let reason = hold(&get, "acme/web", 7, H1, &open(H1, B2, None)).expect("held");
        assert!(reason.contains("couldn't be"), "{reason}");
    }

    #[test]
    fn the_merge_hold_holds_a_rewritten_main_since_the_checks_ran() {
        let get = canned(vec![
            (checks_key(), checks_on(B1)),
            (
                moved_key(),
                r#"{"status":"diverged","ahead_by":1,"behind_by":1,"files":[]}"#.into(),
            ),
        ]);
        let reason = hold(&get, "acme/web", 7, H1, &open(H1, B2, None)).expect("held");
        assert!(reason.contains("rewritten"), "{reason}");
    }

    #[test]
    fn a_commit_id_that_is_not_hex_never_reaches_a_path() {
        let get = canned(vec![]);
        assert!(compare(&get, "acme/web", "../../user", B2).is_err());
        assert!(checks_base(&get, "acme/web", "../../user").is_err());
    }

    /// r2 HIGH: GitHub leaves a check run's `pull_requests` empty for a fork's pull request, and a repo with no CI or a
    /// status-only CI has no check runs at all. The hold then says "waits for a run on the current main", but no run
    /// will ever carry the base, so it holds for good, with main exactly where the branch left it (its merge base, and
    /// GitHub's recorded `pulls/7` base, are main's tip). WP-202 is out of scope for "blocking pull requests that do not
    /// touch the moved files", and nothing moved here.
    #[test]
    fn r2_an_unmoved_main_holds_nothing_when_no_check_run_carries_a_pull_request_base() {
        let unmoved = |checks: &str| {
            canned(vec![
                (checks_key(), checks.to_string()),
                ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
                (
                    format!("compare/{B2}...{H1}"),
                    serde_json::json!({ "status": "ahead", "ahead_by": 1, "behind_by": 0,
                        "merge_base_commit": { "sha": B2 }, "files": [{ "filename": "src/lib.rs" }] })
                    .to_string(),
                ),
                (behind_key(), compare_json(&[], 0)),
                ("pulls/7".into(), serde_json::json!({ "base": { "sha": B2 } }).to_string()),
            ])
        };
        let no_ci = unmoved(r#"{"total_count":0,"check_runs":[]}"#);
        assert_eq!(
            hold(&no_ci, "acme/web", 7, H1, &open(H1, B2, None)),
            None,
            "no CI and main unmoved: nothing to hold"
        );
        let fork = unmoved(
            r#"{"total_count":1,"check_runs":[{"name":"build","status":"completed","conclusion":"success","pull_requests":[]}]}"#,
        );
        assert_eq!(
            hold(&fork, "acme/web", 7, H1, &open(H1, B2, None)),
            None,
            "a fork's green run on the current main: nothing to hold"
        );
    }
}
