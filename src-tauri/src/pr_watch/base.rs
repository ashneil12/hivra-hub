//! The base branch under a watched pull request (WP-202): when main moved, whether what it changed touches the pull
//! request's own files, how far behind main the branch is, and the base the last green run ran on.
//!
//! Every fact comes from GitHub through a `get` (a REST path to its JSON), so the sweep and the merge gate read the
//! same way. Nothing here writes to GitHub. A missing field reads as unknown and holds nothing; a read that fails
//! leaves the watch's base where it was, so the next read tries again.

use super::eval::{Change, Memo};
use super::github::PrRead;

/// GitHub's compare answer lists at most this many files; a list this long may be cut short.
pub const COMPARE_FILE_CAP: usize = 300;
/// One page of a pull request's files: a page this full may be cut short.
pub const PULL_FILES_PAGE: usize = 100;
/// Remembered base wakes per watch (a head and base each add one key).
const TOLD_BASE_MAX: usize = 20;

/// The `get` seam: a REST path (relative to the API root) to its JSON answer.
pub type Get<'a> = &'a dyn Fn(&str) -> Result<String, String>;

/// Files that differ between two commits, from `compare`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compare {
    pub files: Vec<String>,
    pub cut_short: bool,
    /// Commits the first side has that the second lacks: how far behind a branch is.
    pub behind_by: u32,
}

/// What main changed since the watch last saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Moved {
    pub files: Vec<String>,
    pub cut_short: bool,
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
    /// A move or a file list could not be read: the base is not advanced, so the next read asks again.
    pub unread: bool,
    /// Cache entries to store on the memo.
    pub cache_pr_files: Option<(String, Vec<String>, bool)>,
    pub cache_behind: Option<(String, String, u32)>,
}

/// The merge gate's view of one pull request against what it was green on.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Touch {
    None,
    Named(Vec<String>),
    /// GitHub listed only part of one of the file lists: it may touch the pull request.
    Unknown,
}

// ---- parsing (pure) ------------------------------------------------------------------------------------------------

/// A compare answer: its files, and the commits each side has that the other lacks.
pub fn parse_compare(json: &str) -> Result<Compare, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| "GitHub's compare answer was not JSON".to_string())?;
    let files = filenames(value.get("files"))?;
    let behind_by = value
        .get("behind_by")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    Ok(Compare {
        cut_short: files.len() >= COMPARE_FILE_CAP,
        files,
        behind_by,
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
        None => {
            if let Ok(c) = compare(get, repo, head, base) {
                facts.behind = Some(c.behind_by);
                facts.cache_behind = Some((head.into(), base.into(), c.behind_by));
            }
        }
    }
    let Some(old) = memo.base_sha.as_deref() else {
        return facts;
    };
    if old == base {
        return facts;
    }
    let moved = match compare(get, repo, old, base) {
        Ok(c) => Moved {
            files: c.files,
            cut_short: c.cut_short,
        },
        Err(_) => {
            facts.unread = true;
            return facts;
        }
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
pub fn news(
    memo: &mut Memo,
    read: &PrRead,
    facts: &Facts,
    conflict_told: bool,
    passed: bool,
) -> Vec<Change> {
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
    if passed {
        memo.green_base = Some(base.clone());
    }
    if memo.base_sha.as_deref() != Some(base.as_str()) {
        let known = memo.base_sha.is_some();
        match (known, &facts.moved, facts.unread) {
            // A watch from before the base was read: record it, tell nothing.
            (false, _, _) => memo.base_sha = Some(base.clone()),
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
                }
                memo.base_sha = Some(base.clone());
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

/// A stale watch's baseline: main's current base and the green base are taken as already told, so nothing replays.
pub fn settle_stale(memo: &mut Memo, read: &PrRead, passed: bool) {
    memo.base_sha = read.base_tip.clone();
    memo.told_base.clear();
    if passed {
        memo.green_base = read.base_tip.clone();
    }
}

// ---- the merge gate -------------------------------------------------------------------------------------------------

/// The merge gate's base check (WP-202): refuses while main moved since the last green run and what it changed touches
/// this pull request, or when the move cannot be read. `None` means the base holds nothing. `green` is the base the
/// watch's last green run ran on; without a watch there is nothing to compare, so nothing is held here.
pub fn hold(
    get: Get,
    repo: &str,
    number: u64,
    green: Option<&str>,
    read: &PrRead,
) -> Option<String> {
    let green = green?;
    let base = read.base_tip.as_deref()?;
    if green == base {
        return None;
    }
    let pr = format!("{repo}#{number}");
    let moved = match compare(get, repo, green, base) {
        Ok(c) => Moved {
            files: c.files,
            cut_short: c.cut_short,
        },
        Err(error) => {
            return Some(format!(
                "{pr} couldn't be checked against main's changes since its last green run ({error}), so it waits. Try again."
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
            "main moved since {pr}'s last green run, and changed {}. Rebase onto main, push, and wait for green again.",
            files.join(", ")
        )),
        Touch::Unknown => Some(format!(
            "main moved since {pr}'s last green run and changed more files than GitHub lists, so it may touch this pull request. Rebase onto main, push, and wait for green again."
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

    fn compare_json(files: &[&str], behind: u32) -> String {
        serde_json::json!({ "files": files.iter().map(|n| serde_json::json!({ "filename": n })).collect::<Vec<_>>(), "ahead_by": 0, "behind_by": behind }).to_string()
    }

    fn moved_key() -> String {
        format!("compare/{B1}...{B2}")
    }

    fn behind_key() -> String {
        format!("compare/{H1}...{B2}")
    }

    #[test]
    fn a_compare_lists_its_files_and_how_far_behind_it_is() {
        let c = parse_compare(&compare_json(&["src/a.rs", "src/b.rs"], 3)).unwrap();
        assert_eq!(c.files, vec!["src/a.rs", "src/b.rs"]);
        assert_eq!((c.behind_by, c.cut_short), (3, false));
        let full: Vec<&str> = std::iter::repeat_n("x.rs", COMPARE_FILE_CAP).collect();
        assert!(parse_compare(&compare_json(&full, 0)).unwrap().cut_short);
        assert!(parse_compare("not json").is_err());
        assert!(
            parse_compare(r#"{"behind_by":1}"#).is_err(),
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
            news(&mut memo, &read, &got, false, false),
            vec![Change::BaseMoved {
                to: B2.into(),
                files: vec!["src/lib.rs".into()],
                cut_short: false
            }]
        );
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
        // The same read again: the base is recorded, so nothing is news.
        let got = facts_again(&get, &memo, &read);
        assert!(news(&mut memo, &read, &got, false, false).is_empty());
    }

    fn facts_again(get: Get, memo: &Memo, read: &PrRead) -> Facts {
        facts(get, "acme/web", 7, memo, read, false)
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
        assert!(news(&mut memo, &read, &got, false, false).is_empty());
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
    }

    #[test]
    fn behind_is_news_once_per_head_and_base() {
        let get = canned(vec![(behind_key(), compare_json(&[], 3))]);
        let mut memo = Memo::default();
        let read = open(H1, B2, Some("BEHIND"));
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false, false),
            vec![Change::Behind { commits: Some(3) }]
        );
        let got = facts_again(&get, &memo, &read);
        assert!(
            news(&mut memo, &read, &got, false, false).is_empty(),
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
            news(&mut memo, &next, &got, false, false),
            vec![Change::Behind { commits: Some(3) }]
        );
    }

    #[test]
    fn dirty_is_news_once_unless_the_read_already_said_conflicting() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let read = open(H1, B2, Some("DIRTY"));
        let mut memo = Memo::default();
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert_eq!(
            news(&mut memo, &read, &got, false, false),
            vec![Change::Conflicting]
        );
        assert!(news(&mut memo, &read, &got, false, false).is_empty());
        let mut told = Memo::default();
        assert!(
            news(&mut told, &read, &got, true, false).is_empty(),
            "the conflict was already told"
        );
    }

    #[test]
    fn a_watch_with_no_base_recorded_records_it_and_tells_nothing() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let mut memo = Memo::default();
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        assert!(news(&mut memo, &read, &got, false, false).is_empty());
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
        assert!(news(&mut memo, &read, &got, false, false).is_empty());
        assert_eq!(
            memo.base_sha.as_deref(),
            Some(B1),
            "not advanced, so the move is asked for again"
        );
    }

    #[test]
    fn a_passed_read_records_the_base_it_ran_on() {
        let get = canned(vec![(behind_key(), compare_json(&[], 0))]);
        let mut memo = Memo::default();
        let read = open(H1, B2, None);
        let got = facts(&get, "acme/web", 7, &memo, &read, false);
        news(&mut memo, &read, &got, false, true);
        assert_eq!(memo.green_base.as_deref(), Some(B2));
    }

    #[test]
    fn a_stale_watch_reads_nothing_and_settles_on_the_current_base() {
        let get = canned(vec![]);
        let mut memo = Memo {
            base_sha: Some(B1.into()),
            told_base: vec!["behind old".into()],
            ..Memo::default()
        };
        let read = open(H1, B2, Some("BEHIND"));
        let got = facts(&get, "acme/web", 7, &memo, &read, true);
        assert_eq!(
            got,
            Facts::default(),
            "a stale watch asks GitHub for nothing"
        );
        settle_stale(&mut memo, &read, true);
        assert_eq!(memo.base_sha.as_deref(), Some(B2));
        assert!(memo.told_base.is_empty());
        assert_eq!(memo.green_base.as_deref(), Some(B2));
    }

    #[test]
    fn the_merge_hold_refuses_an_overlap_with_what_main_changed_since_green() {
        let get = canned(vec![
            (moved_key(), compare_json(&["src/lib.rs"], 0)),
            ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
        ]);
        let read = open(H1, B2, None);
        let reason = hold(&get, "acme/web", 7, Some(B1), &read).expect("held");
        assert!(
            reason.contains("src/lib.rs") && reason.contains("Rebase onto main"),
            "{reason}"
        );
    }

    #[test]
    fn the_merge_hold_lets_a_move_that_misses_the_pull_request_through() {
        let get = canned(vec![
            (moved_key(), compare_json(&["docs/notes.md"], 0)),
            ("pulls/7/files".into(), files_json(&["src/lib.rs"])),
        ]);
        assert_eq!(
            hold(&get, "acme/web", 7, Some(B1), &open(H1, B2, None)),
            None
        );
    }

    #[test]
    fn the_merge_hold_holds_nothing_without_a_green_base_or_at_the_same_base() {
        let get = canned(vec![]);
        let read = open(H1, B2, None);
        assert_eq!(
            hold(&get, "acme/web", 7, None, &read),
            None,
            "no watch, nothing to compare"
        );
        assert_eq!(
            hold(&get, "acme/web", 7, Some(B2), &read),
            None,
            "green on this base"
        );
        let no_tip = PrRead {
            base_tip: None,
            ..open(H1, B2, None)
        };
        assert_eq!(
            hold(&get, "acme/web", 7, Some(B1), &no_tip),
            None,
            "a missing base field blocks nothing"
        );
    }

    #[test]
    fn the_merge_hold_refuses_when_the_move_cannot_be_read() {
        let get = canned(vec![]);
        let reason = hold(&get, "acme/web", 7, Some(B1), &open(H1, B2, None)).expect("held");
        assert!(reason.contains("couldn't be checked"), "{reason}");
    }

    #[test]
    fn a_commit_id_that_is_not_hex_never_reaches_a_path() {
        let get = canned(vec![]);
        assert!(compare(&get, "acme/web", "../../user", B2).is_err());
    }
}
