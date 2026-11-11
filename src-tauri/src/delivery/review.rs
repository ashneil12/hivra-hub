//! WP-203 H1: the app records the security review. Nothing in a checkout is a record.
//!
//! A review is a delegation the app starts for one head, to one reviewer builder, with the request id
//! `security-review:<owner>/<repo>#<number>@<head>:<reviewer>` and the app-only owner [`OWNER`]. When that delegation
//! completes, the app reads its result (the hunter's output, the findings, the coverage ledger, and each verifier's
//! builder), checks it here, and writes one row keyed by pull request and head. The merge gate reads only that row.
//! Agents have no path to write it: the row is written from the settle of a delegation the app owns, and the author
//! comes from the pull request's delivery row, which the app records when the work is delivered.
//!
//! The checks are the ones the review command's validators make, in Rust and case-folded: a result that is not an
//! object, a missing hunter (no candidate count), a hunter that is not the reviewer, a findings list that is not an
//! array or does not match the candidate count, an unknown verdict, severity or builder, a verifier that is the
//! reviewer or the author, a ledger that does not cover every file the hunter read.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// The owner of every review delegation. Only the app starts one, so only its settle may record a review.
pub const OWNER: &str = "app-security-review";
/// The request id prefix that marks a review delegation.
pub const REQUEST_PREFIX: &str = "security-review-";
/// The builders that may author or review a change.
pub const BUILDERS: [&str; 5] = ["claude", "codex", "grok", "devin", "human"];
const VERDICTS: [&str; 3] = ["confirmed", "needs_validation", "rejected"];
const SEVERITIES: [&str; 5] = ["informational", "low", "medium", "high", "critical"];
/// The most files one review reads (the review command's own cap).
pub const FILE_CAP: usize = 40;
/// How long a review may run before the gate says it is stuck. It still holds the merge: a stuck review never passes.
pub const STUCK_AFTER_MS: i64 = 60 * 60 * 1000;

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS security_reviews (
           repo TEXT NOT NULL,
           number INTEGER NOT NULL,
           head TEXT NOT NULL,
           delegation_id TEXT NOT NULL,
           author TEXT,
           reviewer TEXT NOT NULL,
           status TEXT NOT NULL,
           reason TEXT,
           files TEXT NOT NULL DEFAULT '[]',
           pending TEXT NOT NULL DEFAULT '[]',
           blocking TEXT,
           recorded_at INTEGER NOT NULL,
           PRIMARY KEY (repo, number, head)
         );",
    )?;
    Ok(())
}

/// One name, compared the way the floor compares them: NFKC, then lower case, trimmed.
fn fold(text: &str) -> String {
    text.trim().nfkc().collect::<String>().to_lowercase()
}

/// The builder's folded name when it is one of [`BUILDERS`].
pub fn known_builder(name: &str) -> Option<String> {
    let folded = fold(name);
    BUILDERS.contains(&folded.as_str()).then_some(folded)
}

/// What the request id names: the pull request, its head and the reviewer the app chose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub repo: String,
    pub number: u64,
    pub head: String,
    pub reviewer: String,
}

/// The request id the app gives a review it starts.
/// The request id for one review: the prefix and the hex of its key, so it keeps the id charset the delegation table
/// accepts (letters, digits, dashes) and the key reads back exactly.
pub fn request_id(repo: &str, number: u64, head: &str, reviewer: &str) -> String {
    let key = format!("{repo}#{number}@{head}:{reviewer}");
    let hex: String = key.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{REQUEST_PREFIX}{hex}")
}

fn unhex(text: &str) -> Option<String> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

/// Parses a review's request id. A malformed id, an unknown reviewer or a head that is not a full commit id is an
/// error: the record is refused and the gate says why.
pub fn parse_request(request_id: &str) -> Result<Request, String> {
    let key = request_id
        .strip_prefix(REQUEST_PREFIX)
        .and_then(unhex)
        .ok_or("the request id is not a security review's")?;
    let rest = key.as_str();
    let (target, reviewer) = rest
        .rsplit_once(':')
        .ok_or("the review's request id names no reviewer")?;
    let (repo_number, head) = target
        .rsplit_once('@')
        .ok_or("the review's request id names no head")?;
    let (repo, number) = repo_number
        .rsplit_once('#')
        .ok_or("the review's request id names no pull request")?;
    let number: u64 = number
        .parse()
        .map_err(|_| "the review's pull request number is not a number".to_string())?;
    if !repo.contains('/') {
        return Err("the review's repository is not owner/name".into());
    }
    if head.len() != 40
        || !head
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("the review's head is not a full commit id".into());
    }
    let reviewer = known_builder(reviewer).ok_or("the review's reviewer is not a known builder")?;
    Ok(Request {
        repo: repo.to_ascii_lowercase(),
        number,
        head: head.to_string(),
        reviewer,
    })
}

/// A result the app accepted: what the gate reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Judged {
    /// The files the hunter read in full, each covered by the ledger.
    pub files: Vec<String>,
    /// Candidates that need validation, by title. They do not block; the gate holds for the person's word.
    pub pending: Vec<String>,
    /// A confirmed high or critical finding, if any: the gate refuses the head.
    pub blocking: Option<String>,
}

fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// A reviewer often wraps its JSON in one Markdown code fence. One fence is taken off; anything else is left as it is.
fn strip_one_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    match rest.strip_suffix("```") {
        Some(inner) => inner.trim(),
        None => trimmed,
    }
}

/// The app's checks of one review result. `author` is the pull request's delivery builder; `reviewer` is the one the
/// request id names.
pub fn judge(author: &str, reviewer: &str, result: &str) -> Result<Judged, String> {
    let author = known_builder(author)
        .ok_or("the change's author builder is not recorded, so the review can't be checked")?;
    let reviewer = known_builder(reviewer).ok_or("the reviewer is not a known builder")?;
    if author == reviewer {
        return Err(format!(
            "the same builder ({author}) cannot review its own change"
        ));
    }
    let value: Value = serde_json::from_str(strip_one_fence(result))
        .map_err(|_| "the review's result is not JSON".to_string())?;
    let object = value
        .as_object()
        .ok_or("the review's result is not an object with a hunt, findings and a ledger")?;

    // The hunter: the reviewer's own read of the change. A review with no hunter output is no review.
    let hunt = object
        .get("hunt")
        .and_then(Value::as_object)
        .ok_or("the review has no hunter output")?;
    let hunter = hunt
        .get("builder")
        .and_then(text_of)
        .and_then(|name| known_builder(&name))
        .ok_or("the hunter's builder is not a known builder")?;
    if hunter != reviewer {
        return Err(format!(
            "the hunter ({hunter}) is not the reviewer ({reviewer})"
        ));
    }
    let candidates = hunt
        .get("candidates")
        .and_then(Value::as_u64)
        .ok_or("the hunter's candidate count is missing, so the hunt can't be checked")?;
    let files: Vec<String> = hunt
        .get("files")
        .and_then(Value::as_array)
        .ok_or("the hunter named no files")?
        .iter()
        .map(|file| {
            file.as_str()
                .map(str::to_string)
                .filter(|f| !f.trim().is_empty())
        })
        .collect::<Option<Vec<_>>>()
        .ok_or("the hunter's file list has a name that is not text")?;
    if files.is_empty() {
        return Err("the hunter read no files".into());
    }
    if files.len() > FILE_CAP {
        return Err(format!(
            "the hunter read {} files, more than the {FILE_CAP} one review covers",
            files.len()
        ));
    }

    // Findings: an array, one record per candidate, each verified by a builder that is neither the reviewer nor the author.
    let findings = object
        .get("findings")
        .and_then(Value::as_array)
        .ok_or("the findings are not a list")?;
    if findings.len() as u64 != candidates {
        return Err(format!(
            "the hunter reported {candidates} candidates but the findings list has {}",
            findings.len()
        ));
    }
    let mut pending = Vec::new();
    let mut blocking = None;
    for finding in findings {
        let verdict = finding
            .get("verdict")
            .and_then(text_of)
            .map(|v| fold(&v))
            .filter(|v| VERDICTS.contains(&v.as_str()))
            .ok_or("a finding has no known verdict")?;
        let title = finding
            .get("title")
            .and_then(text_of)
            .filter(|t| !t.trim().is_empty())
            .ok_or("a finding has no title")?;
        let severity = finding
            .get("severity")
            .and_then(|s| s.get("overall_severity"))
            .and_then(text_of)
            .map(|s| fold(&s))
            .filter(|s| SEVERITIES.contains(&s.as_str()))
            .ok_or("a finding has no known severity")?;
        let verifier = finding
            .get("verified_by")
            .and_then(text_of)
            .and_then(|name| known_builder(&name))
            .ok_or("a finding was not verified by a known builder")?;
        if verifier == reviewer {
            return Err(format!(
                "a finding was verified by the reviewer ({reviewer}), not a fresh verifier"
            ));
        }
        if verifier == author {
            return Err(format!(
                "a finding was verified by the change's author ({author})"
            ));
        }
        if verdict == "confirmed"
            && (severity == "high" || severity == "critical")
            && blocking.is_none()
        {
            blocking = Some(format!("{severity}: {title}"));
        }
        if verdict == "needs_validation" {
            pending.push(title);
        }
    }

    // The ledger: every file the hunter read is covered by a unit that says so.
    let units = object
        .get("ledger")
        .and_then(Value::as_array)
        .ok_or("the coverage ledger is missing")?;
    let covered: Vec<&str> = units
        .iter()
        .filter(|unit| unit.get("status").and_then(Value::as_str) == Some("covered"))
        .filter_map(|unit| unit.get("starting_paths")?.get(0)?.as_str())
        .collect();
    let uncovered: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|f| !covered.contains(f))
        .collect();
    if !uncovered.is_empty() {
        return Err(format!(
            "the coverage ledger does not cover every file read: {}",
            uncovered.join(", ")
        ));
    }
    Ok(Judged {
        files,
        pending,
        blocking,
    })
}

/// The reviewer the app starts for a change: the crew default CLI (crew/resolve.rs), never the change's author and never a
/// CLI on `never_use`. None when no other builder is signed in.
pub fn pick_reviewer(
    author: &str,
    present: &[crate::crew::resolve::Presence],
    never_use: &[String],
) -> Option<String> {
    // The author is not a cooled account, but the same skip keeps them from reviewing their own change.
    // Never use is the third list, not folded into cooled.
    let cooled = vec![author.to_string()];
    // Only a builder the app can start a session for can review: the launcher hosts Claude and Codex (launch.ts HOSTS).
    // Any other signed-in CLI is passed over, so one that cannot run never takes the review.
    let usable: Vec<crate::crew::resolve::Presence> = present
        .iter()
        .filter(|row| HOSTABLE.contains(&row.cli.as_str()))
        .cloned()
        .collect();
    crate::crew::resolve::default_cli_except(&usable, &cooled, never_use)
        .and_then(|cli| known_builder(&cli))
        .filter(|reviewer| reviewer != author)
}

/// The reviewers the app can start a session for (launch.ts HOSTS).
pub const HOSTABLE: [&str; 2] = ["claude", "codex"];

/// The hex prefix every review request for one pull request and head shares, whatever the reviewer.
fn key_prefix(repo: &str, number: u64, head: &str) -> String {
    let key = format!("{repo}#{number}@{head}:");
    let hex: String = key.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{REQUEST_PREFIX}{hex}")
}

/// The app's review delegation for this head in one state, if any.
fn review_in_state(
    conn: &Connection,
    repo: &str,
    number: u64,
    head: &str,
    state: &str,
) -> Result<Option<crate::delegations::Delegation>, String> {
    let pattern = format!("{}%", key_prefix(&repo.to_ascii_lowercase(), number, head));
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM delegations WHERE owner_session = ?1 AND request_id LIKE ?2 AND state = ?3 \
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![OWNER, pattern, state],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match id {
        Some(id) => crate::delegations::get(conn, &id),
        None => Ok(None),
    }
}

/// The review delegation still running for this head, if any.
pub fn running_for(
    conn: &Connection,
    repo: &str,
    number: u64,
    head: &str,
) -> Result<Option<crate::delegations::Delegation>, String> {
    review_in_state(conn, repo, number, head, crate::delegations::RUNNING)
}

/// The brief the reviewer gets: the pull request, its head, who wrote the change and what to return. The reviewer's
/// result is the record the app writes; nothing is written to the checkout.
fn brief_for(repo: &str, number: u64, head: &str, author: &str, reviewer: &str) -> String {
    format!(
        "Security review of {repo}#{number} at head {head}. The change was written by {author}; you are {reviewer}, a different \
         builder. Read every changed file at this head (scripts/security-review/review.mjs lists them and the path rules), hunt \
         for security findings, and verify each candidate with a fresh builder that is neither you nor {author}. Return one JSON \
         object: {{\"hunt\": {{\"builder\": \"{reviewer}\", \"candidates\": <count>, \"files\": [<every file read>]}}, \
         \"findings\": [<one record per candidate, each with verdict, title, severity.overall_severity and verified_by>], \
         \"ledger\": [<one covered unit per file read>]}}. Nothing else is written anywhere."
    )
}

/// Starts the review for this head, as the app's own delegation to `reviewer`. The row is recorded as running with the
/// brief; the reviewer's session is started from it, and its settle writes the record.
pub(crate) fn start(
    conn: &mut Connection,
    repo: &str,
    number: u64,
    head: &str,
    author: &str,
    reviewer: &str,
    now: i64,
) -> Result<crate::delegations::Delegation, String> {
    let request = request_id(repo, number, head, reviewer);
    let child = format!("review-{}", &request[REQUEST_PREFIX.len()..]);
    let row = crate::delegations::record(
        conn,
        crate::delegations::RecordInput {
            owner_session: OWNER.into(),
            request_id: request,
            child_session: child,
            title: Some(format!("Security review of {repo}#{number}")),
            brief: Some(brief_for(repo, number, head, author, reviewer)),
            review_launch: true,
            ..Default::default()
        },
        now,
    )?;
    // A cancelled or failed attempt is not a dead end: the same request runs again as a new attempt.
    if row.state == crate::delegations::CANCELLED || row.state == crate::delegations::FAILED {
        return crate::delegations::reopen_review(conn, &row.id, now);
    }
    Ok(row)
}

/// The builder that did a delegation's work: the engine (`harness`) of the session it ran in. None when that engine is not a
/// known builder, or the delegation or its session is gone. Nothing the caller says counts.
pub fn author_for_delegation(
    conn: &Connection,
    delegation_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT s.harness FROM delegations d JOIN sessions s ON s.id = d.child_session WHERE d.id = ?1",
        params![delegation_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|harness| harness.and_then(|name| known_builder(&name)))
    .map_err(|e| e.to_string())
}

/// The author of a pull request: the builder its delivery row records, the newest delivery first.
pub fn author_of(conn: &Connection, repo: &str, number: u64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT author FROM work_deliveries WHERE repo = ?1 AND number = ?2 AND author IS NOT NULL \
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
        params![repo.to_ascii_lowercase(), number as i64],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// The recorded review for one pull request head, or none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub status: String,
    pub reason: Option<String>,
    pub files: Vec<String>,
    pub pending: Vec<String>,
    pub blocking: Option<String>,
    pub reviewer: String,
    pub author: Option<String>,
}

pub fn lookup(
    conn: &Connection,
    repo: &str,
    number: u64,
    head: &str,
) -> Result<Option<Record>, String> {
    conn.query_row(
        "SELECT status, reason, files, pending, blocking, reviewer, author FROM security_reviews \
         WHERE repo = ?1 AND number = ?2 AND head = ?3",
        params![repo.to_ascii_lowercase(), number as i64, head],
        |row| {
            let files: String = row.get(2)?;
            let pending: String = row.get(3)?;
            Ok(Record {
                status: row.get(0)?,
                reason: row.get(1)?,
                files: serde_json::from_str(&files).unwrap_or_default(),
                pending: serde_json::from_str(&pending).unwrap_or_default(),
                blocking: row.get(4)?,
                reviewer: row.get(5)?,
                author: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Called from the settle of a completed review delegation (delegations::settle). Writes one row for its pull request
/// and head: `recorded` when the result passes every check, `refused` with the reason otherwise. A refusal is a
/// record too, so the gate can say why the review does not count.
pub(crate) fn record_settled(
    conn: &Connection,
    delegation_id: &str,
    request_id: &str,
    result: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let request = match parse_request(request_id) {
        Ok(request) => request,
        Err(reason) => return write(conn, delegation_id, None, None, None, Err(reason), now),
    };
    let author = author_of(conn, &request.repo, request.number)?;
    let Some(author_name) = author.clone() else {
        let reason =
            "the change's author is not recorded on its delivery, so the review can't be checked"
                .to_string();
        return write(
            conn,
            delegation_id,
            Some(&request),
            None,
            None,
            Err(reason),
            now,
        );
    };
    let judged = match result {
        Some(text) => judge(&author_name, &request.reviewer, text),
        None => Err("the review finished with no result".into()),
    };
    write(
        conn,
        delegation_id,
        Some(&request),
        Some(&author_name),
        Some(&request.reviewer),
        judged,
        now,
    )
}

fn write(
    conn: &Connection,
    delegation_id: &str,
    request: Option<&Request>,
    author: Option<&str>,
    reviewer: Option<&str>,
    judged: Result<Judged, String>,
    now: i64,
) -> Result<(), String> {
    let Some(request) = request else {
        return Ok(());
    };
    let reviewer = reviewer.unwrap_or(&request.reviewer);
    match judged {
        Ok(judged) => conn.execute(
            "INSERT OR REPLACE INTO security_reviews (repo, number, head, delegation_id, author, reviewer, status, reason, \
             files, pending, blocking, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'recorded', NULL, ?7, ?8, ?9, ?10)",
            params![
                request.repo,
                request.number as i64,
                request.head,
                delegation_id,
                author,
                reviewer,
                serde_json::to_string(&judged.files).map_err(|e| e.to_string())?,
                serde_json::to_string(&judged.pending).map_err(|e| e.to_string())?,
                judged.blocking,
                now,
            ],
        ),
        Err(reason) => conn.execute(
            "INSERT OR REPLACE INTO security_reviews (repo, number, head, delegation_id, author, reviewer, status, reason, \
             files, pending, blocking, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'refused', ?7, '[]', '[]', NULL, ?8)",
            params![request.repo, request.number as i64, request.head, delegation_id, author, reviewer, reason, now],
        ),
    }
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const FILE: &str = "src-tauri/src/mobile_access.rs";

    fn clean(builder: &str) -> String {
        format!(
            r#"{{"hunt":{{"builder":"{builder}","candidates":0,"files":["{FILE}"]}},"findings":[],"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
        )
    }

    #[test]
    fn a_clean_hunt_by_the_reviewer_passes() {
        let judged = judge("codex", "claude", &clean("claude")).unwrap();
        assert_eq!(judged.files, vec![FILE.to_string()]);
        assert_eq!(judged.blocking, None);
    }

    #[test]
    fn a_result_with_no_hunter_output_is_refused() {
        let no_hunt = format!(
            r#"{{"findings":[],"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
        );
        assert_eq!(
            judge("codex", "claude", &no_hunt).unwrap_err(),
            "the review has no hunter output"
        );
        let no_count = format!(
            r#"{{"hunt":{{"builder":"claude","files":["{FILE}"]}},"findings":[],"ledger":[]}}"#
        );
        assert!(judge("codex", "claude", &no_count)
            .unwrap_err()
            .contains("candidate count is missing"));
    }

    #[test]
    fn a_hunter_that_is_not_the_reviewer_is_refused() {
        assert!(judge("codex", "claude", &clean("codex"))
            .unwrap_err()
            .contains("is not the reviewer"));
    }

    #[test]
    fn the_same_builder_cannot_author_and_review_in_any_case() {
        assert!(judge("Claude", "claude", &clean("claude"))
            .unwrap_err()
            .contains("cannot review its own change"));
    }

    #[test]
    fn a_verifier_that_is_the_reviewer_or_the_author_is_refused() {
        let by = |verifier: &str| {
            format!(
                r#"{{"hunt":{{"builder":"claude","candidates":1,"files":["{FILE}"]}},"findings":[{{"verdict":"rejected","title":"x","severity":{{"overall_severity":"low"}},"verified_by":"{verifier}"}}],"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
            )
        };
        assert!(judge("codex", "claude", &by("claude"))
            .unwrap_err()
            .contains("verified by the reviewer"));
        assert!(judge("codex", "claude", &by("codex"))
            .unwrap_err()
            .contains("verified by the change's author"));
        assert!(judge("codex", "claude", &by("human")).is_ok());
    }

    #[test]
    fn severity_and_verdict_are_folded_and_a_high_blocks() {
        let high = format!(
            r#"{{"hunt":{{"builder":"claude","candidates":1,"files":["{FILE}"]}},"findings":[{{"verdict":"Confirmed","title":"Token leaks","severity":{{"overall_severity":"High"}},"verified_by":"human"}}],"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
        );
        let judged = judge("codex", "claude", &high).unwrap();
        assert_eq!(judged.blocking.as_deref(), Some("high: Token leaks"));
        let unknown = high.replace("High", "severe");
        assert!(judge("codex", "claude", &unknown)
            .unwrap_err()
            .contains("no known severity"));
    }

    #[test]
    fn findings_must_be_a_list_that_matches_the_candidate_count() {
        let object = format!(
            r#"{{"hunt":{{"builder":"claude","candidates":0,"files":["{FILE}"]}},"findings":{{"verdict":"confirmed"}},"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
        );
        assert_eq!(
            judge("codex", "claude", &object).unwrap_err(),
            "the findings are not a list"
        );
        let short = format!(
            r#"{{"hunt":{{"builder":"claude","candidates":2,"files":["{FILE}"]}},"findings":[],"ledger":[{{"status":"covered","starting_paths":["{FILE}"]}}]}}"#
        );
        assert!(judge("codex", "claude", &short)
            .unwrap_err()
            .contains("reported 2 candidates"));
    }

    #[test]
    fn a_ledger_that_does_not_cover_a_file_read_is_refused() {
        let uncovered = format!(
            r#"{{"hunt":{{"builder":"claude","candidates":0,"files":["{FILE}"]}},"findings":[],"ledger":[{{"status":"uncovered","starting_paths":["{FILE}"]}}]}}"#
        );
        assert!(judge("codex", "claude", &uncovered)
            .unwrap_err()
            .contains("does not cover every file read"));
    }

    fn session(conn: &Connection, id: &str, harness: &str) {
        conn.execute(
            "INSERT INTO sessions (id, cwd, harness, model, runtime_mode, title, created_at, updated_at) \
             VALUES (?1, '/tmp', ?2, 'm', 'auto', 't', 1, 1)",
            params![id, harness],
        )
        .unwrap();
    }

    #[test]
    fn the_author_is_the_work_sessions_engine_and_nothing_the_caller_says() {
        let store = crate::session_store::SessionStore::open_in_memory().unwrap();
        let mut conn = store.lock_conn().unwrap();
        session(&conn, "codex-child", "codex");
        session(&conn, "odd-child", "some-other-engine");
        let codex = crate::delegations::record(
            &mut conn,
            crate::delegations::RecordInput {
                owner_session: "lead-1".into(),
                request_id: "work-1".into(),
                child_session: "codex-child".into(),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        let odd = crate::delegations::record(
            &mut conn,
            crate::delegations::RecordInput {
                owner_session: "lead-1".into(),
                request_id: "work-2".into(),
                child_session: "odd-child".into(),
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(
            author_for_delegation(&conn, &codex.id).unwrap().as_deref(),
            Some("codex")
        );
        // An engine that is not a builder gives no author, so the review is refused rather than guessed.
        assert_eq!(author_for_delegation(&conn, &odd.id).unwrap(), None);
        assert_eq!(
            author_for_delegation(&conn, "no-such-delegation").unwrap(),
            None
        );
        // A caller's author is not read: the delivery input has no such field, so a value in its JSON is ignored.
        let parsed: crate::delivery::deliver::DeliverInput =
            serde_json::from_value(serde_json::json!({
                "project": "/p",
                "checkout": "/c",
                "author": "claude",
            }))
            .unwrap();
        assert_eq!(parsed.delegation_id, None);
    }

    #[test]
    fn one_code_fence_around_the_result_is_taken_off_and_nothing_more() {
        let fenced = format!("```json\n{}\n```", clean("claude"));
        assert!(judge("codex", "claude", &fenced).is_ok());
        let double = format!("```\n```json\n{}\n```\n```", clean("claude"));
        assert!(judge("codex", "claude", &double).is_err());
    }

    #[test]
    fn only_a_builder_the_app_can_host_is_picked_to_review() {
        use crate::crew::resolve::Presence;
        let p = |cli: &str| Presence {
            cli: cli.into(),
            installed: true,
            signed_in: true,
        };
        // grok is installed and signed in but cannot host a review session: it is passed over, not picked.
        let present = [p("grok"), p("codex")];
        assert_eq!(
            pick_reviewer("claude", &present, &[]).as_deref(),
            Some("codex")
        );
        assert_eq!(pick_reviewer("claude", &[p("grok")], &[]), None);
    }

    #[test]
    fn a_request_id_names_one_head_and_one_known_reviewer() {
        let id = request_id("Acme/Web", 7, HEAD, "Claude");
        let parsed = parse_request(&id).unwrap();
        assert_eq!(parsed.repo, "acme/web");
        assert_eq!(parsed.reviewer, "claude");
        assert!(parse_request(&request_id("acme/web", 7, "abc", "claude")).is_err());
        assert!(parse_request(&request_id("acme/web", 7, HEAD, "someone")).is_err());
        assert!(parse_request("not a review").is_err());
    }
}
