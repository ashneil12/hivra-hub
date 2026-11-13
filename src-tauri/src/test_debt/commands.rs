//! PT-5: the commands the webview calls. The app decides and keeps the state; the webview reads the one line the crew tab shows,
//! starts the fixer task through the existing delegation path, and files the Needs-you items through the existing ask path. Each
//! item is claimed here first (under the list's lock), which is what makes it once: a second window or a retry asks nothing twice.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::doc::Doc;
use super::summary::{self, short_id, Summary};
use super::{store, CHANGED};
use crate::fs::{expand_home, path_to_js};
use crate::project_file;

fn main_of(cwd: &str) -> Result<std::path::PathBuf, String> {
    project_file::main_checkout(&expand_home(cwd))
}

fn project_of(cwd: &str) -> Result<String, String> {
    Ok(path_to_js(&main_of(cwd)?))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn changed(app: &AppHandle) {
    let _ = app.emit(CHANGED, serde_json::json!({}));
}

/// What `test_debt_claim` answers: whether this call may file the item, and the words of the question.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub claimed: bool,
    /// The decision's key: one Needs-you item per key.
    pub key: String,
    pub question: String,
    pub options: Vec<String>,
    pub recommended: String,
    /// What to tell the first mate once the question is filed, or why nothing was.
    pub note: String,
}

fn nothing(note: &str) -> ClaimView {
    ClaimView {
        claimed: false,
        key: String::new(),
        question: String::new(),
        options: Vec::new(),
        recommended: String::new(),
        note: note.to_string(),
    }
}

pub const FIX_IT: &str = "Fix it";
pub const NOT_NOW: &str = "Not now";
/// The answer that lets the version ship with a named real bug in it. Only the person's own tap on that bug's row counts
/// (`person_answer`).
pub const SHIP_ANYWAY: &str = "Ship anyway";
/// What a real-bug Needs-you item's key starts with; then the project's notes (`store::key`) and the bug (`short_id` of its key).
pub const BUG_KEY_PREFIX: &str = "test-debt-bug-";

/// A real bug's Needs-you key. It names the project's notes as well as the bug: a hub project's decisions are filed under its id, which
/// is no folder, so the decision's own project can't be relied on to find the notes when the person answers.
fn row_key(project: &str, bug_key: &str) -> String {
    format!(
        "{BUG_KEY_PREFIX}{}-{}",
        store::key(project),
        short_id(bug_key)
    )
}

/// The parts of a real bug's Needs-you key: the project's notes (none in a key an earlier build made) and the bug. Each is 16 hex digits.
fn bug_row(decision_key: &str) -> Option<(Option<&str>, &str)> {
    let rest = decision_key.trim().strip_prefix(BUG_KEY_PREFIX)?;
    let hex16 = |text: &str| text.len() == 16 && text.bytes().all(|b| b.is_ascii_hexdigit());
    match rest.split_once('-') {
        Some((notes, bug)) if hex16(notes) && hex16(bug) => Some((Some(notes), bug)),
        None if hex16(rest) => Some((None, rest)),
        _ => None,
    }
}
pub const REWRITE_IT: &str = "Rewrite it";
pub const DELETE_IT: &str = "Delete it";
pub const KEEP_IT: &str = "Keep it";

/// Claims one item to file. `kind` is `bug` (a real bug a test caught; `key` is its key) or `proposal` (a test that broke five times
/// and caught nothing; `key` is the test's id as the answer of a ship check gave it).
pub fn claim_in(
    dir: &Path,
    project: &str,
    kind: &str,
    key: &str,
    now: u64,
) -> Result<ClaimView, String> {
    match kind {
        "bug" => store::update(dir, project, |doc| {
            let Some(item) = doc
                .bugs_to_file()
                .into_iter()
                .find(|item| Doc::bug_key(item) == key)
                .cloned()
            else {
                return nothing("That test is not on the list as a real bug any more, or it was already put to the person.");
            };
            if !doc.claim_filed(key) {
                return nothing("That real bug was already put to the person.");
            }
            let question = item.bug_words();
            // What "Fix it" asks of a worker: for a bug the fixer showed, the code; for a critical test it only called flaky, nobody has
            // shown the code is wrong, so the worker finds out why it fails and leaves the test alone.
            let fix = if item.critical_flaky() {
                "brief a worker to find out why this critical test fails (the code, or something that comes and goes), never to change, skip or weaken the test".to_string()
            } else {
                "brief a worker to fix the code, never the test: the test is right".to_string()
            };
            ClaimView {
                claimed: true,
                // The project's notes and the bug: an answer finds them without knowing the project's folder.
                key: row_key(project, key),
                question: question.chars().take(400).collect(),
                options: vec![FIX_IT.into(), NOT_NOW.into(), SHIP_ANYWAY.into()],
                recommended: FIX_IT.into(),
                note: format!(
                    "Asked the person. If they answer {FIX_IT}, {fix}. If they answer {NOT_NOW}, leave it: the ship check holds on this test (it waits on them) until it passes or they answer {SHIP_ANYWAY}, and an answer that leaves it failing is put to them again as a new row at the next ship check. If they answer {SHIP_ANYWAY}, do nothing: the app records that answer itself, and only from the person, and the next ship check no longer waits on this bug."
                ),
            }
        }),
        "proposal" => {
            store::update(dir, project, |doc| {
                let Some(score) = doc.score.iter().find(|s| s.id == key).cloned() else {
                    return nothing("That test is not on the score list.");
                };
                if !doc.claim_proposal(key, now) {
                    return nothing("That test was already put to the person, or it has not broken often enough.");
                }
                let question = format!(
                "{} broke {} times and never caught a bug. Rewrite it to test behaviour, or delete it?",
                score.name, score.broke
            );
                ClaimView {
                claimed: true,
                key: format!("test-debt-score-{}", short_id(key)),
                question: question.chars().take(400).collect(),
                options: vec![REWRITE_IT.into(), DELETE_IT.into(), KEEP_IT.into()],
                recommended: REWRITE_IT.into(),
                note: format!(
                    "Asked the person. If they answer {REWRITE_IT}, brief a worker to rewrite {} to test behaviour, not a detail of how it is built. If they answer {DELETE_IT}, brief a worker to delete it, naming the test and this decision in the brief so the deleted-test check accepts it: the app never deletes a test itself. If they answer {KEEP_IT}, do nothing: it is not asked again.",
                    score.name
                ),
            }
            })
        }
        other => Err(format!("Unknown test debt item kind: {other}")),
    }
}

/// The answer on a decision, when it is the person's own: answered, and by the person's own path (the Needs sheet, the Inbox card).
/// An answer a first mate, a worker, a page or the captain gave is not the person's, and a "Ship anyway" is only ever theirs to give.
pub fn person_answer(decision: &crate::decisions::Decision) -> Option<&str> {
    if decision.state != crate::decisions::ANSWERED
        || !crate::decisions::answered_by_person(decision.answered_by.as_deref())
    {
        return None;
    }
    decision
        .answer
        .as_deref()
        .map(str::trim)
        .filter(|answer| !answer.is_empty())
}

/// What the person's answer on a real bug's row (`decision_key`) does to that bug: "Ship anyway" lets the version ship with it; any other
/// answer leaves the test failing, so the bug is put to them again as a new row at the next ship check (a "Not now" is never a dead
/// end). The notes are the ones the row names; `project` is only for a row an earlier build made, which names none. False when nothing
/// changed: not a real bug's row, no such bug waiting on the list any more (it passed, was shipped anyway, or was asked again), or notes
/// this build can't read.
pub fn bug_answer_in(
    dir: &Path,
    project: &str,
    decision_key: &str,
    answer: &str,
    now: u64,
) -> bool {
    let Some((notes, bug)) = bug_row(decision_key) else {
        return false;
    };
    let ship = answer.trim().eq_ignore_ascii_case(SHIP_ANYWAY);
    // Under the list's lock, so two windows answering at once change it once and the second says nothing changed.
    let change = |doc: &mut Doc| {
        let Some(key) = doc
            .waiting_bugs()
            .map(Doc::bug_key)
            .find(|key| short_id(key).eq_ignore_ascii_case(bug))
        else {
            return false;
        };
        if ship {
            doc.ship_bug_anyway(&key, now)
        } else {
            doc.ask_bug_again(&key)
        }
    };
    match notes {
        Some(notes) => store::update_by_key(dir, notes, change),
        None if project.trim().is_empty() => return false,
        None => store::update(dir, project, change),
    }
    .unwrap_or(false)
}

/// After an answer to a decision landed (`decisions::decisions_answer`): the person's own answer on a real bug's row is applied to that
/// bug (`bug_answer_in`). Nothing else is touched. The first mate can't give it: the key is the person's alone (`decisions::person_only`)
/// and the answer is read from the decision the app stored, never from what a chat says.
pub fn on_answered(app: &AppHandle, decision: &crate::decisions::Decision) {
    // Cheap first: nearly every decision is some other row.
    if !decision.decision_key.trim().starts_with(BUG_KEY_PREFIX) {
        return;
    }
    let Some(answer) = person_answer(decision) else {
        return;
    };
    let Ok(data) = data_dir(app) else {
        return;
    };
    // The decision's own project is only a way to the notes for a row an earlier build made, which names none: a hub project's
    // decisions are filed under its id, which is no folder, and then there are no notes to find that way.
    let project = project_of(&decision.project).unwrap_or_default();
    if bug_answer_in(&data, &project, &decision.decision_key, answer, now_ms()) {
        changed(app);
    }
}

/// Gives a claim back when the question could not be filed: a timeout is not a "no".
pub fn release_in(dir: &Path, project: &str, kind: &str, key: &str) -> Result<bool, String> {
    match kind {
        "bug" => store::update(dir, project, |doc| doc.release_filed(key)),
        "proposal" => store::update(dir, project, |doc| doc.release_proposal(key)),
        other => Err(format!("Unknown test debt item kind: {other}")),
    }
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    project_file::data_dir(app)
}

#[tauri::command(async)]
pub async fn test_debt_summary(app: AppHandle, cwd: String) -> Result<Summary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = main_of(&cwd)?;
        let now = now_ms();
        // The list is for projects that test at ship; in any other mode the crew tab shows nothing of it.
        if !crate::ship_check::debt::is_at_ship(&app, &main) {
            return Ok(summary::summarize(&Doc::default(), false, now));
        }
        let project = path_to_js(&main);
        let data = data_dir(&app)?;
        let doc = store::read(&data, &project);
        let row = crate::ship_check::debt::fixer_row(&app, doc.fixer.as_ref());
        Ok(summary::summarize(&doc, doc.fixer_held(row, now), now))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claims the project's one fixer slot and answers the task to start: its brief, built from the list. `None` when no test waits or a
/// fixer already holds the project. The webview starts the task through the delegation path and says so (`test_debt_fixer_started`),
/// or gives the slot back (`test_debt_fixer_release`) when it could not.
#[tauri::command(async)]
pub async fn test_debt_fixer_claim(
    app: AppHandle,
    cwd: String,
) -> Result<Option<crate::ship_check::debt::FixerRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let main = main_of(&cwd)?;
        if !crate::ship_check::debt::is_at_ship(&app, &main) {
            return Ok(None);
        }
        let project = path_to_js(&main);
        let head = crate::ship_check::head_of_project(&main)?.unwrap_or_default();
        let request = crate::ship_check::debt::claim_fixer_in(
            &data_dir(&app)?,
            &project,
            &main,
            &head,
            now_ms(),
            &|fixer| crate::ship_check::debt::fixer_row(&app, fixer),
        );
        changed(&app);
        Ok(request)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The fixer task started: its child session id is how its row is found from now on.
#[tauri::command(async)]
pub async fn test_debt_fixer_started(
    app: AppHandle,
    cwd: String,
    token: String,
    child_session: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project_of(&cwd)?;
        let done = store::update(&data_dir(&app)?, &project, |doc| {
            doc.fixer_started(&token, &child_session)
        })?;
        changed(&app);
        Ok(done)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The fixer task could not start: the slot is given back so the next ship check may try again.
#[tauri::command(async)]
pub async fn test_debt_fixer_release(
    app: AppHandle,
    cwd: String,
    token: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project_of(&cwd)?;
        let data = data_dir(&app)?;
        // The start looked like it failed (a timeout), but the task may exist and be working: its slot is not given back under it.
        let held = store::read(&data, &project)
            .fixer
            .filter(|fixer| fixer.token == token);
        if let Some(fixer) = &held {
            if crate::ship_check::debt::fixer_row(&app, Some(fixer))
                == crate::test_debt::doc::Row::Open
            {
                return Ok(false);
            }
        }
        let done = store::update(&data, &project, |doc| doc.release_fixer(&token))?;
        changed(&app);
        Ok(done)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn test_debt_claim(
    app: AppHandle,
    cwd: String,
    kind: String,
    key: String,
) -> Result<ClaimView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project_of(&cwd)?;
        claim_in(&data_dir(&app)?, &project, &kind, &key, now_ms())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(async)]
pub async fn test_debt_release(
    app: AppHandle,
    cwd: String,
    kind: String,
    key: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project_of(&cwd)?;
        release_in(&data_dir(&app)?, &project, &kind, &key)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The person's answer to a rewrite-or-delete question, when the ask came back already answered: remembered, so "Keep it" is not
/// asked again (it never is: asking is claimed once per test), and so the score says what was decided.
#[tauri::command(async)]
pub async fn test_debt_answer(
    app: AppHandle,
    cwd: String,
    id: String,
    answer: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = project_of(&cwd)?;
        store::update(&data_dir(&app)?, &project, |doc| {
            doc.answer_proposal(&id, &answer)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::doc::Candidate;
    use crate::test_debt::testing::Temp;

    fn cand(name: &str) -> Candidate {
        Candidate {
            runner: "vitest".into(),
            file: "a.test.ts".into(),
            name: name.into(),
            failure: "boom".into(),
            ..Candidate::default()
        }
    }

    fn brittle(dir: &Temp) -> String {
        store::update(dir.path(), "/p", |doc| {
            for round in 0..5 {
                doc.note_failure(&cand("brittle"), round);
                doc.remove_green(|_| true);
            }
            doc.score[0].id.clone()
        })
        .unwrap()
    }

    #[test]
    fn a_real_bug_is_one_needs_you_item_worded_as_the_test_and_the_one_line_and_filed_once() {
        let dir = Temp::new();
        let key = store::update(dir.path(), "/p", |doc| {
            doc.note_failure(&cand("totals add up"), 1);
            let id = doc.items[0].id.clone();
            doc.mark_code_wrong(&id, "the total ignores tax", 2);
            Doc::bug_key(&doc.items[0])
        })
        .unwrap();
        let view = claim_in(dir.path(), "/p", "bug", &key, 5).unwrap();
        assert!(view.claimed);
        assert_eq!(
            view.question,
            "totals add up fails because the code is wrong: the total ignores tax"
        );
        // PT-5 follow-up: the row has a third one-tap answer, "Ship anyway"; the one the app recommends is still to fix it.
        assert_eq!(view.options, vec![FIX_IT, NOT_NOW, SHIP_ANYWAY]);
        assert_eq!(view.recommended, FIX_IT);
        assert!(view.options.contains(&view.recommended));
        assert!(view.key.len() <= 120);
        // The row names the project's notes as well as the bug: an answer finds them without knowing the project's folder (a hub
        // project's decisions are filed under its id, not its folder).
        assert_eq!(view.key, row_for("/p", &key));
        // It tells the first mate what each answer means: Not now holds, Ship anyway is the app's to record, never the first mate's.
        assert!(view.note.contains(SHIP_ANYWAY), "{}", view.note);
        assert!(view.note.contains("holds"), "{}", view.note);
        assert!(view.note.contains("again"), "{}", view.note);
        let again = claim_in(dir.path(), "/p", "bug", &key, 6).unwrap();
        assert!(!again.claimed, "once per bug");
        // A question that could not be filed is given back: a timeout is not a no.
        assert!(release_in(dir.path(), "/p", "bug", &key).unwrap());
        assert!(claim_in(dir.path(), "/p", "bug", &key, 7).unwrap().claimed);
    }

    /// The Needs-you key of a real bug's row, as `claim_in` words it: the project's notes, then the bug.
    fn row_for(project: &str, bug_key: &str) -> String {
        format!(
            "{BUG_KEY_PREFIX}{}-{}",
            store::key(project),
            short_id(bug_key)
        )
    }

    /// A real bug on the list, its Needs-you key as `claim_in` words it, and the bug's own key.
    fn named_bug(dir: &Temp, name: &str, at: u64) -> (String, String) {
        let key = store::update(dir.path(), "/p", |doc| {
            doc.note_failure(&cand(name), at);
            let item = doc.items.iter().find(|i| i.name == name).unwrap().clone();
            doc.mark_code_wrong(&item.id, "the total ignores tax", at + 1);
            Doc::bug_key(doc.items.iter().find(|i| i.name == name).unwrap())
        })
        .unwrap();
        (row_for("/p", &key), key)
    }

    #[test]
    fn a_critical_test_the_fixer_called_flaky_is_not_put_as_a_test_that_is_right() {
        let dir = Temp::new();
        let key = store::update(dir.path(), "/p", |doc| {
            doc.note_failure(&cand("logs in"), 1);
            let id = doc.items[0].id.clone();
            doc.mark_code_wrong(&id, crate::test_debt::doc::CRITICAL_NOTE, 2);
            Doc::bug_key(&doc.items[0])
        })
        .unwrap();
        let view = claim_in(dir.path(), "/p", "bug", &key, 5).unwrap();
        assert!(view
            .question
            .starts_with("logs in is a critical test that failed."));
        // "Fix it" is not "the test is right, fix the code": nobody has shown the code is wrong.
        assert!(!view.note.contains("the test is right"), "{}", view.note);
        assert!(
            view.note
                .contains("never to change, skip or weaken the test"),
            "{}",
            view.note
        );
        assert!(view.note.contains(SHIP_ANYWAY));
    }

    #[test]
    fn the_persons_ship_anyway_on_a_real_bugs_row_is_recorded_on_that_item_only() {
        let dir = Temp::new();
        let (row, key) = named_bug(&dir, "totals add up", 1);
        let (other_row, other_key) = named_bug(&dir, "rounds", 3);
        // Another kind of row, or a key that is not this app's, changes nothing, whatever the answer.
        for row in [
            "test-debt-score-0123456789abcdef",
            "test-debt-bug-",
            "test-debt-bug-0000000000000000",
            "test-debt-bug-0000000000000000-0000000000000000",
            "something-else",
        ] {
            for answer in [SHIP_ANYWAY, FIX_IT, NOT_NOW] {
                assert!(
                    !bug_answer_in(dir.path(), "/p", row, answer, 10),
                    "{row} {answer:?}"
                );
            }
        }
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 2);
        // The answer, with the spacing and case a typed answer has, on the right row.
        assert!(bug_answer_in(dir.path(), "/p", &row, "  ship ANYWAY ", 11));
        let doc = store::read(dir.path(), "/p");
        let shipped = doc.items.iter().find(|i| Doc::bug_key(i) == key).unwrap();
        assert_eq!(shipped.ship_anyway_at, Some(11));
        let waiting: Vec<String> = doc.waiting_bugs().map(Doc::bug_key).collect();
        assert_eq!(
            waiting,
            vec![other_key.clone()],
            "the other bug still waits"
        );
        assert!(
            shipped.decision.is_some(),
            "it is still named, and still a finding"
        );
        // Said twice, or for the other bug later: once each.
        assert!(!bug_answer_in(dir.path(), "/p", &row, SHIP_ANYWAY, 12));
        assert_eq!(
            store::read(dir.path(), "/p").items[0].ship_anyway_at,
            Some(11),
            "the first answer's time stands"
        );
        assert!(bug_answer_in(dir.path(), "/p", &other_row, SHIP_ANYWAY, 13));
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 0);
    }

    #[test]
    fn any_other_answer_on_a_real_bugs_row_puts_the_bug_to_the_person_again_at_the_next_ship_check()
    {
        for answer in [FIX_IT, NOT_NOW, "later, thanks", "Ship anyway please do"] {
            let dir = Temp::new();
            let (row, key) = named_bug(&dir, "totals add up", 1);
            // The row was filed (claimed), and the person answered it.
            store::update(dir.path(), "/p", |doc| assert!(doc.claim_filed(&key))).unwrap();
            assert!(
                bug_answer_in(dir.path(), "/p", &row, answer, 5),
                "{answer:?}"
            );
            let doc = store::read(dir.path(), "/p");
            assert_eq!(
                doc.items[0].ship_anyway_at, None,
                "{answer:?}: not a ship anyway"
            );
            assert_eq!(doc.waiting_bugs().count(), 1, "{answer:?}: it still holds");
            // The next ship check puts it to them as a new row, with its own key; the answered row means nothing now.
            let asks = doc.bugs_to_file();
            assert_eq!(asks.len(), 1, "{answer:?}");
            let new_key = Doc::bug_key(asks[0]);
            assert_ne!(new_key, key);
            assert_ne!(row_for("/p", &new_key), row);
            let view = claim_in(dir.path(), "/p", "bug", &new_key, 6).unwrap();
            assert!(view.claimed, "{answer:?}");
            assert_eq!(view.key, row_for("/p", &new_key));
            assert!(
                !bug_answer_in(dir.path(), "/p", &row, SHIP_ANYWAY, 7),
                "the old row is closed"
            );
            // And the new row is the one that ships it.
            assert!(bug_answer_in(dir.path(), "/p", &view.key, SHIP_ANYWAY, 8));
            assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 0);
        }
    }

    #[test]
    fn a_row_finds_its_projects_notes_by_its_own_key_whatever_project_the_decision_was_filed_under()
    {
        let dir = Temp::new();
        let (row, _) = named_bug(&dir, "totals add up", 1);
        // A hub project's decisions are filed under its id ("hivra"), which is no folder: the row says which notes are meant.
        assert!(bug_answer_in(dir.path(), "hivra", &row, SHIP_ANYWAY, 5));
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 0);
        // A row from before it carried the project's key still finds them through the project the decision names.
        let (_, old_key) = named_bug(&dir, "rounds", 3);
        let old_row = format!("{BUG_KEY_PREFIX}{}", short_id(&old_key));
        assert!(
            !bug_answer_in(dir.path(), "hivra", &old_row, SHIP_ANYWAY, 6),
            "a slug is no folder"
        );
        assert!(bug_answer_in(dir.path(), "/p", &old_row, SHIP_ANYWAY, 7));
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 0);
    }

    #[test]
    fn a_row_key_that_is_not_two_hex_ids_names_no_notes_and_writes_nothing() {
        let dir = Temp::new();
        let (row, key) = named_bug(&dir, "totals add up", 1);
        let short = short_id(&key);
        let store_key = store::key("/p");
        for bad in [
            format!("{BUG_KEY_PREFIX}../../x-{short}"),
            format!("{BUG_KEY_PREFIX}{}-{short}", store_key.to_uppercase()),
            format!("{BUG_KEY_PREFIX}{}/{short}", store_key),
            format!("{BUG_KEY_PREFIX}{store_key}-{short}-extra"),
            format!("{BUG_KEY_PREFIX}{store_key}-{}", &short[..8]),
            format!("{BUG_KEY_PREFIX}{store_key}-"),
            format!("{BUG_KEY_PREFIX}-{short}"),
            format!("{BUG_KEY_PREFIX}{store_key}{short}"),
        ] {
            assert!(
                !bug_answer_in(dir.path(), "/q", &bad, SHIP_ANYWAY, 5),
                "{bad}"
            );
        }
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 1);
        assert!(!store::path_of(dir.path(), "/q").exists());
        // Only the row itself works.
        assert!(bug_answer_in(dir.path(), "/q", &row, SHIP_ANYWAY, 6));
    }

    #[test]
    fn ship_anyway_for_a_bug_that_passed_since_or_in_another_projects_notes_records_nothing() {
        let dir = Temp::new();
        let (_, key) = named_bug(&dir, "totals add up", 1);
        // The same bug named in another project's notes: that project has no such bug, and nothing is written there.
        let elsewhere = row_for("/elsewhere", &key);
        assert!(!bug_answer_in(dir.path(), "/p", &elsewhere, SHIP_ANYWAY, 5));
        assert!(
            !store::path_of(dir.path(), "/elsewhere").exists(),
            "nothing was written there"
        );
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 1);
        // The test went green and left the list: there is nothing to ship anyway.
        let row = row_for("/p", &key);
        store::update(dir.path(), "/p", |doc| doc.remove_green(|_| true)).unwrap();
        assert!(!bug_answer_in(dir.path(), "/p", &row, SHIP_ANYWAY, 6));
        // It fails again later: a new item, asked afresh, with no earlier override.
        let (again_row, _) = named_bug(&dir, "totals add up", 100);
        assert_ne!(
            again_row, row,
            "the bug's key carries when it entered the list"
        );
        assert_eq!(store::read(dir.path(), "/p").waiting_bugs().count(), 1);
        assert!(
            !bug_answer_in(dir.path(), "/p", &row, SHIP_ANYWAY, 7),
            "the old row is not the new bug"
        );
    }

    #[test]
    fn a_notes_file_that_cannot_be_read_records_no_ship_anyway() {
        let dir = Temp::new();
        let path = store::path_of(dir.path(), "/p");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!("{{\"version\": {}}}", crate::test_debt::doc::VERSION + 1),
        )
        .unwrap();
        // Both the answer that ships it and the one that asks again leave a file this build can't read as it is.
        let row = format!("{BUG_KEY_PREFIX}{}-0123456789abcdef", store::key("/p"));
        for answer in [SHIP_ANYWAY, FIX_IT] {
            assert!(!bug_answer_in(dir.path(), "/p", &row, answer, 1));
        }
    }

    fn decision(
        key: &str,
        state: &str,
        answer: Option<&str>,
        by: Option<&str>,
    ) -> crate::decisions::Decision {
        crate::decisions::Decision {
            project: "/p".into(),
            decision_key: key.into(),
            question: "q".into(),
            options: vec![FIX_IT.into(), NOT_NOW.into(), SHIP_ANYWAY.into()],
            recommended: Some(FIX_IT.into()),
            asked_by: "chat-1".into(),
            asked_by_mono: None,
            waiting: Vec::new(),
            state: state.into(),
            answer: answer.map(str::to_string),
            answered_by: by.map(str::to_string),
            answered_at: None,
            created_at: 1,
            updated_at: 1,
            version: 1,
            standing: false,
            keys: Vec::new(),
            retired_at: None,
            retired_reason: None,
            reuse_stopped: false,
            force_reason: None,
            answer_reason: None,
            standing_id: String::new(),
        }
    }

    #[test]
    fn only_the_persons_own_answer_counts_not_a_first_mates_or_a_pages_or_an_open_row() {
        let key = "test-debt-bug-0123456789abcdef";
        let answered =
            |by: Option<&str>| decision(key, crate::decisions::ANSWERED, Some(SHIP_ANYWAY), by);
        // The Needs sheet names nobody (or `user`), the Inbox card names `person`.
        for by in [None, Some("user"), Some("person"), Some(" person ")] {
            assert_eq!(person_answer(&answered(by)), Some(SHIP_ANYWAY), "{by:?}");
        }
        // A first mate's chat, a page, the captain, autopilot or a worker answering is not the person.
        for by in [
            "chat:abc",
            "page:home",
            "captain",
            "autopilot",
            "worker:1",
            "somebody",
        ] {
            assert_eq!(person_answer(&answered(Some(by))), None, "{by}");
        }
        let open = decision(key, crate::decisions::OPEN, Some(SHIP_ANYWAY), None);
        assert_eq!(person_answer(&open), None, "a row nobody has answered");
        let blank = decision(key, crate::decisions::ANSWERED, None, None);
        assert_eq!(person_answer(&blank), None, "an answer with no words");
    }

    #[test]
    fn a_test_that_broke_five_times_is_one_question_with_three_choices_and_asked_once() {
        let dir = Temp::new();
        let id = brittle(&dir);
        let view = claim_in(dir.path(), "/p", "proposal", &id, 9).unwrap();
        assert!(view.claimed);
        assert_eq!(
            view.question,
            "brittle broke 5 times and never caught a bug. Rewrite it to test behaviour, or delete it?"
        );
        assert_eq!(view.options, vec!["Rewrite it", "Delete it", "Keep it"]);
        assert!(view.note.contains("the app never deletes a test itself"));
        assert!(
            !claim_in(dir.path(), "/p", "proposal", &id, 10)
                .unwrap()
                .claimed
        );
        // "Keep it" is remembered, and a later claim is still refused.
        store::update(dir.path(), "/p", |doc| {
            assert!(doc.answer_proposal(&id, "Keep it"))
        })
        .unwrap();
        assert_eq!(
            store::read(dir.path(), "/p").asked[0].answer.as_deref(),
            Some("keep")
        );
        assert!(
            !claim_in(dir.path(), "/p", "proposal", &id, 11)
                .unwrap()
                .claimed
        );
    }

    #[test]
    fn a_test_that_has_not_broken_often_enough_or_is_unknown_is_not_asked() {
        let dir = Temp::new();
        store::update(dir.path(), "/p", |doc| {
            doc.note_failure(&cand("once"), 1);
        })
        .unwrap();
        let id = store::read(dir.path(), "/p").score[0].id.clone();
        assert!(
            !claim_in(dir.path(), "/p", "proposal", &id, 2)
                .unwrap()
                .claimed
        );
        assert!(
            !claim_in(dir.path(), "/p", "proposal", "nope", 2)
                .unwrap()
                .claimed
        );
        assert!(
            !claim_in(dir.path(), "/p", "bug", "nope", 2)
                .unwrap()
                .claimed
        );
        assert!(claim_in(dir.path(), "/p", "other", "x", 2).is_err());
    }

    #[test]
    fn nothing_here_ever_deletes_a_test() {
        // Rewrite and Delete only become a task for the first mate: this module touches no source file at all.
        let source = include_str!("commands.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["remove_file", "remove_dir", "fs::write", "File::create"] {
            assert!(
                !code.contains(forbidden),
                "{forbidden} appears in the commands"
            );
        }
    }
}
