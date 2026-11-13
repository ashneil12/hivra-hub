//! PT-5: the document a project's test debt lives in, and every rule that changes it. Pure: no disk, no clock (the
//! caller passes `now`), so each rule is a unit test. `store.rs` reads and writes it.
//!
//! What it holds, per project:
//! - `items`: the test debt list. One item per test id (runner, file, name), however many tasks saw it fail.
//! - `quarantine`: flaky tests. A quarantined test still runs and reports; its failure never joins the list or blocks. It comes
//!   back `QUARANTINE_MS` after it was added.
//! - `score`: per test id, how many times it entered the list (`broke`) and how many real bugs it caught (`caught`: an item the
//!   fixer called "code is wrong" that then ran green after a fix).
//! - `asked` / `filed`: what was already put to the person (a rewrite-or-delete question once per test; a real-bug item once).
//! - `fixer`: the one test fixer task a project may have at a time.
//!
//! Everything read from disk is untrusted (`Doc::sane`): lengths are cut, duplicates dropped, counts capped.

use serde::{Deserialize, Serialize};

/// The document's shape version. A file with a higher one was written by a newer build and is never written over.
pub const VERSION: u32 = 1;
/// The failure text kept per item.
pub const FAILURE_MAX: usize = 1_500;
/// The most tests on one project's list (the rest are counted by the caller, never dropped silently).
pub const ITEMS_MAX: usize = 500;
const SCORES_MAX: usize = 1_000;
const QUARANTINE_MAX: usize = 200;
const KEYS_MAX: usize = 1_000;
const NAME_MAX: usize = 300;
const FILE_MAX: usize = 400;
const LINE_MAX: usize = 300;
const ID_MAX: usize = 800;
/// A quarantine lasts 14 days.
pub const QUARANTINE_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// A test that broke this many times and never caught a bug is put to the person once.
pub const BROKE_LIMIT: u32 = 5;
/// The most rewrite-or-delete questions one ship check puts forward.
pub const PROPOSALS_MAX: usize = 3;
/// A fixer claim with no delegation row yet is still held this long (the start takes seconds, not minutes).
pub const CLAIM_GRACE_MS: u64 = 10 * 60 * 1000;

/// What the fixer decided about one test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionKind {
    /// A real bug: the code is wrong and the test is right.
    CodeWrong,
    /// It passes on a re-run.
    Flaky,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub kind: DecisionKind,
    /// One plain line: why.
    pub line: String,
    pub at: u64,
}

/// One failing test waiting to be sorted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    /// `runner|file|name`: only ever compared whole.
    pub id: String,
    pub runner: String,
    pub file: String,
    pub name: String,
    /// The worker copy's HEAD when it was first seen failing.
    pub first_commit: String,
    pub delegation_id: String,
    pub task_title: String,
    pub failure: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
    pub seen_count: u32,
    /// The check that failed it (a `run_checks` step id), so a later green run of that check can clear it.
    pub command: String,
    pub decision: Option<Decision>,
    /// One plain line the app left for the next fixer about a decision it did not accept (`NO_GREEN_NOTE`). Empty when there is none.
    pub note: String,
}

/// What a test the fixer called flaky is told when it is critical: it is never quarantined, and it waits for the person.
pub const CRITICAL_NOTE: &str = "A critical test can't be quarantined; it waits for you.";
/// What a test the fixer called flaky is told when its own runs show no green run of it after it was listed.
pub const NO_GREEN_NOTE: &str = "No green run seen; still to sort.";

impl Item {
    /// The one sentence a real bug is put as, on the ship check and to the person. A critical test the fixer called flaky is said as
    /// what it is.
    pub fn bug_words(&self) -> String {
        let line = self
            .decision
            .as_ref()
            .map(|d| d.line.as_str())
            .filter(|line| !line.is_empty())
            .unwrap_or("see the fixer's report");
        if line == CRITICAL_NOTE {
            format!(
                "{} is a critical test that failed. {CRITICAL_NOTE}",
                self.name
            )
        } else {
            format!("{} fails because the code is wrong: {line}", self.name)
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Quarantined {
    pub id: String,
    pub name: String,
    pub file: String,
    pub reason: String,
    pub added_at: u64,
    pub ends_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Score {
    pub id: String,
    pub name: String,
    /// Times it entered the list.
    pub broke: u32,
    /// Real bugs it caught.
    pub caught: u32,
}

/// A rewrite-or-delete question already put to the person.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Asked {
    pub id: String,
    pub at: u64,
    /// `rewrite`, `delete` or `keep`, once the answer is known. "Keep it" is remembered here and never asked again.
    pub answer: Option<String>,
}

/// The one test fixer task a project may have.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fixer {
    /// What the ship check named the claim: the request id the task is started under, so a retry is the same task.
    pub token: String,
    /// The task's child session id (`app-<chat>-<request>`): how its delegation row is found. Empty until it has started.
    pub child_session: String,
    pub claimed_at: u64,
    /// The version the ship check that started it covered.
    pub head: String,
    /// The test ids on its brief, in the order the brief numbered them: what its report's `Decision <n>` lines mean.
    pub items: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Doc {
    pub version: u32,
    /// Counts every write. A write that was based on an older read is refused (`store::update`).
    pub rev: u64,
    pub items: Vec<Item>,
    pub quarantine: Vec<Quarantined>,
    pub score: Vec<Score>,
    pub asked: Vec<Asked>,
    /// Keys of real-bug Needs-you items already filed.
    pub filed: Vec<String>,
    pub fixer: Option<Fixer>,
}

impl Default for Doc {
    fn default() -> Doc {
        Doc {
            version: VERSION,
            rev: 0,
            items: Vec::new(),
            quarantine: Vec::new(),
            score: Vec::new(),
            asked: Vec::new(),
            filed: Vec::new(),
            fixer: None,
        }
    }
}

/// A failing test as a task's gate or a ship check saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Candidate {
    pub runner: String,
    pub file: String,
    pub name: String,
    pub failure: String,
    pub command: String,
    pub first_commit: String,
    pub delegation_id: String,
    pub task_title: String,
}

impl Candidate {
    pub fn id(&self) -> String {
        test_id(&self.runner, &self.file, &self.name)
    }
}

/// What noting a failure did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Noted {
    /// It joined the list.
    Added,
    /// It was already on the list.
    Seen,
    /// It is quarantined: reported, never listed.
    Quarantined,
    /// The list is full. The caller says so.
    Full,
}

/// Whether the fixer is still working: asked of the delegation rows by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    /// The task's row is open (running, or asking).
    Open,
    /// The task's row has settled (done, failed, cancelled).
    Settled,
    /// No row yet: the start is still on its way, or never landed.
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FixerClaim {
    Claimed,
    /// Another fixer holds the project: its child session id.
    Held(String),
}

/// One rewrite-or-delete question due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Due {
    pub id: String,
    pub name: String,
    pub broke: u32,
}

fn tidy_line(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cut(
        flat.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .as_str(),
        max,
    )
}

/// Keeps line breaks (a failure's message has several lines), drops every other control character and cuts.
fn tidy_text(text: &str, max: usize) -> String {
    let kept: String = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    cut(kept.trim(), max)
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// A test's id. Only ever compared whole, never taken apart. The parts are joined with the unit separator, which `tidy_line` has taken
/// out of every part, so two different tests (a file name with a `|` in it) can never share an id.
pub fn test_id(runner: &str, file: &str, name: &str) -> String {
    cut(
        &format!(
            "{}\u{1f}{}\u{1f}{}",
            tidy_line(runner, 40),
            tidy_line(&file.replace('\\', "/"), FILE_MAX),
            tidy_line(name, NAME_MAX)
        ),
        ID_MAX,
    )
}

/// Test output can print what it should not (an environment variable, a connection string). A failure's text is kept, put in a
/// brief and shown, so it goes through the same scrubber an export does (`portable::scrubber`) before it is kept.
fn scrubbed(text: &str) -> String {
    crate::portable::scrubber().redact_text(text).0
}

fn dedupe_by<T, K: Eq + std::hash::Hash>(items: Vec<T>, key: impl Fn(&T) -> K) -> Vec<T> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(key(item)))
        .collect()
}

impl Doc {
    /// A document read from disk: only what is plausible. Strings are cut, an item with no id is dropped, duplicates keep
    /// their first, and every list is capped.
    pub fn sane(mut self) -> Doc {
        self.items = dedupe_by(
            self.items
                .into_iter()
                .filter(|item| !item.id.trim().is_empty())
                .map(|mut item| {
                    item.id = cut(&item.id, ID_MAX);
                    item.runner = tidy_line(&item.runner, 40);
                    item.file = tidy_line(&item.file, FILE_MAX);
                    item.name = tidy_line(&item.name, NAME_MAX);
                    item.first_commit = tidy_line(&item.first_commit, 64);
                    item.delegation_id = tidy_line(&item.delegation_id, 200);
                    item.task_title = tidy_line(&item.task_title, LINE_MAX);
                    item.failure = tidy_text(&item.failure, FAILURE_MAX);
                    item.command = tidy_line(&item.command, 200);
                    item.note = tidy_line(&item.note, LINE_MAX);
                    item.seen_count = item.seen_count.max(1);
                    item.last_seen_at = item.last_seen_at.max(item.first_seen_at);
                    item.decision = item.decision.map(|mut d| {
                        d.line = tidy_line(&d.line, LINE_MAX);
                        d
                    });
                    item
                })
                .collect(),
            |item| item.id.clone(),
        );
        self.items.truncate(ITEMS_MAX);
        self.quarantine = dedupe_by(
            self.quarantine
                .into_iter()
                .filter(|q| !q.id.trim().is_empty())
                .map(|mut q| {
                    q.id = cut(&q.id, ID_MAX);
                    q.name = tidy_line(&q.name, NAME_MAX);
                    q.file = tidy_line(&q.file, FILE_MAX);
                    q.reason = tidy_line(&q.reason, LINE_MAX);
                    // A hand-edited end date a century away is not a quarantine, it is a deletion.
                    q.ends_at = q.ends_at.min(q.added_at.saturating_add(QUARANTINE_MS));
                    q
                })
                .collect(),
            |q| q.id.clone(),
        );
        self.quarantine.truncate(QUARANTINE_MAX);
        self.score = dedupe_by(
            self.score
                .into_iter()
                .filter(|s| !s.id.trim().is_empty())
                .map(|mut s| {
                    s.id = cut(&s.id, ID_MAX);
                    s.name = tidy_line(&s.name, NAME_MAX);
                    s
                })
                .collect(),
            |s| s.id.clone(),
        );
        if self.score.len() > SCORES_MAX {
            // Keep what matters: the ones that caught something, then the ones that broke most.
            self.score
                .sort_by(|a, b| (b.caught, b.broke).cmp(&(a.caught, a.broke)));
            self.score.truncate(SCORES_MAX);
        }
        self.asked = dedupe_by(
            self.asked
                .into_iter()
                .filter(|a| !a.id.trim().is_empty())
                .map(|mut a| {
                    a.id = cut(&a.id, ID_MAX);
                    a.answer = a
                        .answer
                        .filter(|answer| matches!(answer.as_str(), "rewrite" | "delete" | "keep"));
                    a
                })
                .collect(),
            |a| a.id.clone(),
        );
        self.asked.truncate(KEYS_MAX);
        self.filed = dedupe_by(
            self.filed
                .into_iter()
                .filter(|key| !key.trim().is_empty())
                .map(|key| cut(&key, ID_MAX + 40))
                .collect(),
            |key| key.clone(),
        );
        self.filed.truncate(KEYS_MAX);
        self.fixer = self
            .fixer
            .filter(|f| !f.token.trim().is_empty())
            .map(|mut f| {
                f.token = tidy_line(&f.token, 200);
                f.child_session = tidy_line(&f.child_session, 200);
                f.head = tidy_line(&f.head, 64);
                f.items = f
                    .items
                    .into_iter()
                    .map(|id| cut(&id, ID_MAX))
                    .take(64)
                    .collect();
                f
            });
        self
    }

    /// Whether `id` is quarantined right now (not yet past its end date).
    pub fn quarantined(&self, id: &str, now: u64) -> bool {
        self.quarantine
            .iter()
            .any(|entry| entry.id == id && now < entry.ends_at)
    }

    fn score_entry(&mut self, id: &str, name: &str) -> &mut Score {
        if let Some(at) = self.score.iter().position(|s| s.id == id) {
            return &mut self.score[at];
        }
        self.score.push(Score {
            id: id.to_string(),
            name: tidy_line(name, NAME_MAX),
            broke: 0,
            caught: 0,
        });
        let last = self.score.len() - 1;
        &mut self.score[last]
    }

    /// A failing test, as one task or ship check saw it. Deduplicates by test id: a second sighting counts, it does not add a
    /// second item. A quarantined test is never listed.
    pub fn note_failure(&mut self, candidate: &Candidate, now: u64) -> Noted {
        let id = candidate.id();
        if self.quarantined(&id, now) {
            return Noted::Quarantined;
        }
        let failure = tidy_text(&scrubbed(&candidate.failure), FAILURE_MAX);
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.last_seen_at = item.last_seen_at.max(now);
            item.seen_count = item.seen_count.saturating_add(1);
            if !failure.is_empty() {
                item.failure = failure;
            }
            return Noted::Seen;
        }
        if self.items.len() >= ITEMS_MAX {
            return Noted::Full;
        }
        self.items.push(Item {
            id: id.clone(),
            runner: tidy_line(&candidate.runner, 40),
            file: tidy_line(&candidate.file.replace('\\', "/"), FILE_MAX),
            name: tidy_line(&candidate.name, NAME_MAX),
            first_commit: tidy_line(&candidate.first_commit, 64),
            delegation_id: tidy_line(&candidate.delegation_id, 200),
            task_title: tidy_line(&candidate.task_title, LINE_MAX),
            failure,
            first_seen_at: now,
            last_seen_at: now,
            seen_count: 1,
            command: tidy_line(&candidate.command, 200),
            decision: None,
            note: String::new(),
        });
        let score = self.score_entry(&id, &candidate.name);
        score.broke = score.broke.saturating_add(1);
        Noted::Added
    }

    /// Takes off the list every item `green` says ran green. An item the fixer called "code is wrong" that goes green was a
    /// real bug caught: its test's score says so. Returns what left.
    #[cfg(test)]
    pub fn remove_green(&mut self, green: impl FnMut(&Item) -> bool) -> Vec<Item> {
        self.remove_green_with(green, |_| true)
    }

    /// `remove_green`, crediting a caught bug only when `exists` says the test is still there: a command that went green because its
    /// test was deleted or renamed fixed nothing, and must not count as a bug caught.
    pub fn remove_green_with(
        &mut self,
        mut green: impl FnMut(&Item) -> bool,
        exists: impl Fn(&Item) -> bool,
    ) -> Vec<Item> {
        let (gone, keep): (Vec<Item>, Vec<Item>) = std::mem::take(&mut self.items)
            .into_iter()
            .partition(|item| green(item));
        self.items = keep;
        for item in &gone {
            if exists(item)
                && item
                    .decision
                    .as_ref()
                    .is_some_and(|d| d.kind == DecisionKind::CodeWrong)
            {
                let score = self.score_entry(&item.id, &item.name);
                score.caught = score.caught.saturating_add(1);
            }
        }
        gone
    }

    /// Items still to sort: no named decision yet.
    pub fn undecided(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|item| item.decision.is_none())
    }

    /// Items named as real bugs, still on the list.
    pub fn real_bugs(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|item| {
            item.decision
                .as_ref()
                .is_some_and(|d| d.kind == DecisionKind::CodeWrong)
        })
    }

    /// Records the fixer's "code is wrong". False when the test is not on the list (it went green, or was never there).
    pub fn mark_code_wrong(&mut self, id: &str, line: &str, now: u64) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) => {
                item.decision = Some(Decision {
                    kind: DecisionKind::CodeWrong,
                    line: tidy_line(line, LINE_MAX),
                    at: now,
                });
                true
            }
            None => false,
        }
    }

    /// A decision the app did not accept leaves its reason on the test, which stays undecided for the next fixer. False when the test is
    /// not on the list.
    pub fn note_unproven(&mut self, id: &str, note: &str) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) => {
                item.note = tidy_line(note, LINE_MAX);
                true
            }
            None => false,
        }
    }

    /// The fixer's "flaky": the test leaves the list and is quarantined for `QUARANTINE_MS`. False when it is not on the list.
    pub fn mark_flaky(&mut self, id: &str, reason: &str, now: u64) -> bool {
        let Some(at) = self.items.iter().position(|item| item.id == id) else {
            return false;
        };
        let item = self.items.remove(at);
        self.quarantine_entry(item.id, item.name, item.file, reason, now);
        true
    }

    /// A worker's request in `light` or `full`: the test is quarantined for `QUARANTINE_MS` from now, whether or not it is on the list
    /// (those modes keep no list). A test already on the list stays there until the fixer sorts it; a quarantined test is never listed
    /// again. Asking again starts the 14 days over.
    pub fn quarantine_test(&mut self, id: &str, name: &str, file: &str, reason: &str, now: u64) {
        // The reason is the worker's own words, kept and shown: it goes through the scrubber like a failure's text does.
        self.quarantine_entry(
            id.to_string(),
            tidy_line(name, NAME_MAX),
            tidy_line(&file.replace('\\', "/"), FILE_MAX),
            &scrubbed(reason),
            now,
        );
    }

    fn quarantine_entry(&mut self, id: String, name: String, file: String, reason: &str, now: u64) {
        self.quarantine.retain(|entry| entry.id != id);
        // A full quarantine makes room by letting the entry that ends soonest go: a test that was called flaky, or that a worker asked
        // to have quarantined, is never quietly not quarantined.
        while self.quarantine.len() >= QUARANTINE_MAX {
            let Some(soonest) = self
                .quarantine
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.ends_at)
                .map(|(at, _)| at)
            else {
                break;
            };
            self.quarantine.remove(soonest);
        }
        self.quarantine.push(Quarantined {
            id,
            name,
            file,
            reason: tidy_line(reason, LINE_MAX),
            added_at: now,
            ends_at: now.saturating_add(QUARANTINE_MS),
        });
    }

    /// Quarantine entries past their end date: they come back. Removed, and returned so the ship check lists each once.
    pub fn take_expired(&mut self, now: u64) -> Vec<Quarantined> {
        let (expired, kept): (Vec<Quarantined>, Vec<Quarantined>) =
            std::mem::take(&mut self.quarantine)
                .into_iter()
                .partition(|entry| now >= entry.ends_at);
        self.quarantine = kept;
        expired
    }

    /// Tests that broke `BROKE_LIMIT` times or more and never caught a bug, not yet put to the person. Most broken first, at
    /// most `PROPOSALS_MAX`.
    pub fn proposals_due(&self) -> Vec<Due> {
        let mut due = self.due_all();
        due.truncate(PROPOSALS_MAX);
        due
    }

    /// Every test that is due, most broken first, with no cap.
    fn due_all(&self) -> Vec<Due> {
        let mut due: Vec<Due> = self
            .score
            .iter()
            .filter(|s| {
                s.broke >= BROKE_LIMIT && s.caught == 0 && !self.asked.iter().any(|a| a.id == s.id)
            })
            .map(|s| Due {
                id: s.id.clone(),
                name: s.name.clone(),
                broke: s.broke,
            })
            .collect();
        due.sort_by(|a, b| b.broke.cmp(&a.broke).then_with(|| a.id.cmp(&b.id)));
        due
    }

    /// Claims the right to ask about `id`: once per test, ever. False when it is not due or was already asked. A test past the
    /// cap of `proposals_due` is claimable too: the cap is how many one ship check puts forward, not who may be asked.
    pub fn claim_proposal(&mut self, id: &str, now: u64) -> bool {
        if !self.due_all().iter().any(|due| due.id == id) {
            return false;
        }
        if self.asked.len() >= KEYS_MAX {
            return false;
        }
        self.asked.push(Asked {
            id: id.to_string(),
            at: now,
            answer: None,
        });
        true
    }

    /// Gives the claim back when the question could not be filed (a timeout is not a "no").
    pub fn release_proposal(&mut self, id: &str) -> bool {
        let before = self.asked.len();
        self.asked
            .retain(|asked| !(asked.id == id && asked.answer.is_none()));
        self.asked.len() != before
    }

    /// Remembers the person's answer to a question that was asked. `keep` is never asked again (asked is permanent either way).
    pub fn answer_proposal(&mut self, id: &str, answer: &str) -> bool {
        let word = match answer.trim().to_lowercase().as_str() {
            "rewrite it" | "rewrite" => "rewrite",
            "delete it" | "delete" => "delete",
            "keep it" | "keep" => "keep",
            _ => return false,
        };
        match self.asked.iter_mut().find(|asked| asked.id == id) {
            Some(asked) => {
                asked.answer = Some(word.to_string());
                true
            }
            None => false,
        }
    }

    /// A real-bug Needs-you item's key: the test and when it entered the list, so a bug that comes back later is a new item.
    pub fn bug_key(item: &Item) -> String {
        format!("code-wrong:{}:{}", item.id, item.first_seen_at)
    }

    /// Real bugs not yet put to the person.
    pub fn bugs_to_file(&self) -> Vec<&Item> {
        self.real_bugs()
            .filter(|item| !self.filed.contains(&Doc::bug_key(item)))
            .collect()
    }

    /// Claims the right to file one real-bug item. False when it was already filed.
    pub fn claim_filed(&mut self, key: &str) -> bool {
        if self.filed.iter().any(|filed| filed == key) || self.filed.len() >= KEYS_MAX {
            return false;
        }
        self.filed.push(key.to_string());
        true
    }

    pub fn release_filed(&mut self, key: &str) -> bool {
        let before = self.filed.len();
        self.filed.retain(|filed| filed != key);
        self.filed.len() != before
    }

    /// Whether the fixer still holds the project, given what the delegation rows say about its task.
    pub fn fixer_held(&self, row: Row, now: u64) -> bool {
        match (&self.fixer, row) {
            (None, _) => false,
            (Some(_), Row::Open) => true,
            (Some(_), Row::Settled) => false,
            (Some(fixer), Row::Missing) => now < fixer.claimed_at.saturating_add(CLAIM_GRACE_MS),
        }
    }

    /// Claims the one fixer slot. `row` is what the delegation rows say about the current holder's task.
    pub fn claim_fixer(
        &mut self,
        token: &str,
        head: &str,
        items: Vec<String>,
        row: Row,
        now: u64,
    ) -> FixerClaim {
        if self.fixer_held(row, now) {
            if let Some(fixer) = &self.fixer {
                return FixerClaim::Held(fixer.token.clone());
            }
        }
        self.fixer = Some(Fixer {
            token: tidy_line(token, 200),
            child_session: String::new(),
            claimed_at: now,
            head: tidy_line(head, 64),
            items,
        });
        FixerClaim::Claimed
    }

    /// The task started: its child session id is how its row is found from now on. Only the claim made for `token` is updated.
    pub fn fixer_started(&mut self, token: &str, child_session: &str) -> bool {
        match self.fixer.as_mut().filter(|fixer| fixer.token == token) {
            Some(fixer) => {
                fixer.child_session = tidy_line(child_session, 200);
                true
            }
            None => false,
        }
    }

    /// Gives the slot back when the task could not start. Only the claim made for `token` is given back.
    pub fn release_fixer(&mut self, token: &str) -> bool {
        if self
            .fixer
            .as_ref()
            .is_some_and(|fixer| fixer.token == token)
        {
            self.fixer = None;
            return true;
        }
        false
    }

    /// Whether this child session is the fixer's task. Its child session id is recorded when it starts; a task that finishes before
    /// that was recorded (or whose recording failed) is still known by the request id it started under: `app-<chat>-<token>`.
    pub fn is_fixer(&self, child_session: &str) -> bool {
        let child = child_session.trim();
        !child.is_empty()
            && self.fixer.as_ref().is_some_and(|fixer| {
                fixer.child_session == child
                    || (fixer.child_session.is_empty()
                        && child.ends_with(&format!("-{}", fixer.token)))
            })
    }

    /// The task finished and its report was read: the slot is free. Only the fixer's own task frees it.
    pub fn fixer_done(&mut self, child_session: &str) -> Option<Fixer> {
        if self.is_fixer(child_session) {
            return self.fixer.take();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(file: &str, name: &str) -> Candidate {
        Candidate {
            runner: "vitest".into(),
            file: file.into(),
            name: name.into(),
            failure: "expected 1 to be 2".into(),
            command: "affected".into(),
            first_commit: "abc1234".into(),
            delegation_id: "d1".into(),
            task_title: "Add totals".into(),
        }
    }

    #[test]
    fn a_failing_test_joins_the_list_once_however_often_it_is_seen() {
        let mut doc = Doc::default();
        assert_eq!(
            doc.note_failure(&cand("src/a.test.ts", "adds"), 10),
            Noted::Added
        );
        assert_eq!(
            doc.note_failure(&cand("src/a.test.ts", "adds"), 20),
            Noted::Seen
        );
        assert_eq!(
            doc.note_failure(&cand("src/a.test.ts", "adds"), 30),
            Noted::Seen
        );
        assert_eq!(doc.items.len(), 1);
        let item = &doc.items[0];
        assert_eq!(
            (item.first_seen_at, item.last_seen_at, item.seen_count),
            (10, 30, 3)
        );
        assert_eq!(item.first_commit, "abc1234");
        assert_eq!(item.delegation_id, "d1");
        // A different name or file is a different test.
        doc.note_failure(&cand("src/a.test.ts", "subtracts"), 40);
        doc.note_failure(&cand("src/b.test.ts", "adds"), 40);
        assert_eq!(doc.items.len(), 3);
    }

    #[test]
    fn the_first_sighting_keeps_the_first_commit_and_task_a_later_one_only_refreshes_the_text() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 1);
        let mut later = cand("a.test.ts", "t");
        later.first_commit = "ffff000".into();
        later.task_title = "Another task".into();
        later.failure = "new text".into();
        doc.note_failure(&later, 2);
        assert_eq!(doc.items[0].first_commit, "abc1234");
        assert_eq!(doc.items[0].task_title, "Add totals");
        assert_eq!(doc.items[0].failure, "new text");
    }

    #[test]
    fn failure_text_is_cut_to_1500_characters_and_stripped_of_control_characters() {
        let mut doc = Doc::default();
        let mut long = cand("a.test.ts", "t");
        long.failure = format!("line one\u{7}\n{}", "x".repeat(3_000));
        doc.note_failure(&long, 1);
        let text = &doc.items[0].failure;
        assert_eq!(text.chars().count(), FAILURE_MAX);
        assert!(!text.contains('\u{7}'));
        assert!(text.starts_with("line one\n"));
    }

    #[test]
    fn a_green_run_removes_the_item_and_a_return_enters_it_again_as_a_second_break() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 1);
        let gone = doc.remove_green(|item| item.command == "affected");
        assert_eq!(gone.len(), 1);
        assert!(doc.items.is_empty());
        doc.note_failure(&cand("a.test.ts", "t"), 5);
        assert_eq!(doc.score[0].broke, 2);
        // What did not run green stays.
        doc.note_failure(&cand("b.test.ts", "u"), 6);
        let gone = doc.remove_green(|item| item.file == "a.test.ts");
        assert_eq!(gone.len(), 1);
        assert_eq!(doc.items.len(), 1);
        assert_eq!(doc.items[0].file, "b.test.ts");
    }

    #[test]
    fn a_quarantined_test_never_joins_the_list_and_comes_back_after_its_end_date() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "flaky one"), 100);
        let id = doc.items[0].id.clone();
        assert!(doc.mark_flaky(&id, "passed on a re-run", 1_000));
        assert!(doc.items.is_empty(), "a quarantined test leaves the list");
        assert_eq!(doc.quarantine[0].ends_at, 1_000 + QUARANTINE_MS);
        assert!(doc.quarantined(&id, 1_000 + QUARANTINE_MS - 1));
        assert_eq!(
            doc.note_failure(&cand("a.test.ts", "flaky one"), 2_000),
            Noted::Quarantined
        );
        assert!(doc.items.is_empty());
        // Past the end date it is no longer quarantined: it joins the list again, and is listed once as expired.
        let end = 1_000 + QUARANTINE_MS;
        assert!(!doc.quarantined(&id, end));
        assert_eq!(
            doc.note_failure(&cand("a.test.ts", "flaky one"), end),
            Noted::Added
        );
        let expired = doc.take_expired(end);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].name, "flaky one");
        assert!(
            doc.take_expired(end).is_empty(),
            "each expired entry is listed once"
        );
    }

    #[test]
    fn a_hand_edited_end_date_far_in_the_future_is_cut_back_to_14_days() {
        let mut doc = Doc::default();
        doc.quarantine.push(Quarantined {
            id: "x".into(),
            added_at: 5,
            ends_at: u64::MAX,
            ..Quarantined::default()
        });
        let doc = doc.sane();
        assert_eq!(doc.quarantine[0].ends_at, 5 + QUARANTINE_MS);
    }

    #[test]
    fn the_score_counts_breaks_and_only_a_fixed_real_bug_counts_as_caught() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 1);
        let id = doc.items[0].id.clone();
        assert!(doc.mark_code_wrong(&id, "totals ignore tax", 2));
        // Named, but not fixed: still a break, nothing caught yet.
        assert_eq!((doc.score[0].broke, doc.score[0].caught), (1, 0));
        let gone = doc.remove_green(|_| true);
        assert_eq!(gone.len(), 1);
        assert_eq!((doc.score[0].broke, doc.score[0].caught), (1, 1));
    }

    #[test]
    fn an_item_that_goes_green_without_a_code_is_wrong_decision_catches_nothing() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 1);
        doc.remove_green(|_| true);
        assert_eq!((doc.score[0].broke, doc.score[0].caught), (1, 0));
    }

    fn break_it(doc: &mut Doc, times: u32) {
        for round in 0..times {
            doc.note_failure(&cand("a.test.ts", "brittle"), 10 + u64::from(round));
            doc.remove_green(|_| true);
        }
    }

    #[test]
    fn a_test_that_broke_five_times_and_caught_nothing_is_due_once_and_never_before() {
        let mut doc = Doc::default();
        break_it(&mut doc, 4);
        assert!(doc.proposals_due().is_empty(), "four breaks is not enough");
        break_it(&mut doc, 1);
        let due = doc.proposals_due();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].broke, 5);
        let id = due[0].id.clone();
        assert!(doc.claim_proposal(&id, 99));
        assert!(!doc.claim_proposal(&id, 100), "asked once per test");
        assert!(doc.proposals_due().is_empty());
        // More breaks later do not ask again.
        break_it(&mut doc, 3);
        assert!(doc.proposals_due().is_empty());
        assert!(!doc.claim_proposal(&id, 200));
    }

    #[test]
    fn a_test_that_caught_a_real_bug_is_never_proposed() {
        let mut doc = Doc::default();
        break_it(&mut doc, 4);
        doc.note_failure(&cand("a.test.ts", "brittle"), 50);
        let id = doc.items[0].id.clone();
        doc.mark_code_wrong(&id, "real", 51);
        doc.remove_green(|_| true);
        assert_eq!(doc.score[0].broke, 5);
        assert_eq!(doc.score[0].caught, 1);
        assert!(doc.proposals_due().is_empty());
    }

    #[test]
    fn a_question_that_could_not_be_filed_is_given_back_but_an_answered_one_is_not() {
        let mut doc = Doc::default();
        break_it(&mut doc, 5);
        let id = doc.score[0].id.clone();
        assert!(doc.claim_proposal(&id, 1));
        assert!(doc.release_proposal(&id));
        assert_eq!(doc.proposals_due().len(), 1, "a timeout is not a final no");
        assert!(doc.claim_proposal(&id, 2));
        assert!(doc.answer_proposal(&id, "Keep it"));
        assert!(
            !doc.release_proposal(&id),
            "an answered question stays asked"
        );
        assert_eq!(doc.asked[0].answer.as_deref(), Some("keep"));
        assert!(doc.proposals_due().is_empty(), "Keep it is remembered");
        assert!(!doc.answer_proposal(&id, "Maybe"));
    }

    #[test]
    fn at_most_three_questions_are_due_at_once_most_broken_first() {
        let mut doc = Doc::default();
        for (index, times) in [5u32, 9, 6, 7].into_iter().enumerate() {
            let name = format!("t{index}");
            for round in 0..times {
                doc.note_failure(&cand("a.test.ts", &name), u64::from(round));
                doc.remove_green(|_| true);
            }
        }
        let due = doc.proposals_due();
        assert_eq!(
            due.iter().map(|d| d.broke).collect::<Vec<_>>(),
            vec![9, 7, 6]
        );
        // The fourth is claimable by a later call, once.
        let fourth = doc.score.iter().find(|s| s.broke == 5).unwrap().id.clone();
        assert!(doc.claim_proposal(&fourth, 1));
        assert!(!doc.claim_proposal(&fourth, 2));
    }

    #[test]
    fn a_real_bug_is_filed_once_and_a_return_after_a_fix_is_a_new_item() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 10);
        let id = doc.items[0].id.clone();
        doc.mark_code_wrong(&id, "x", 11);
        let key = Doc::bug_key(&doc.items[0]);
        assert_eq!(doc.bugs_to_file().len(), 1);
        assert!(doc.claim_filed(&key));
        assert!(!doc.claim_filed(&key));
        assert!(doc.bugs_to_file().is_empty());
        doc.remove_green(|_| true);
        doc.note_failure(&cand("a.test.ts", "t"), 500);
        doc.mark_code_wrong(&id, "again", 501);
        assert_eq!(
            doc.bugs_to_file().len(),
            1,
            "a bug that comes back is asked about again"
        );
    }

    #[test]
    fn a_filing_that_failed_is_given_back() {
        let mut doc = Doc::default();
        assert!(doc.claim_filed("k"));
        assert!(doc.release_filed("k"));
        assert!(doc.claim_filed("k"));
    }

    #[test]
    fn only_one_fixer_holds_a_project_until_its_task_settles() {
        let mut doc = Doc::default();
        assert_eq!(
            doc.claim_fixer("tok-a", "h1", vec!["x".into()], Row::Missing, 100),
            FixerClaim::Claimed
        );
        // Its row is not there yet: the start is on its way, so a second ship check does not start another.
        assert_eq!(
            doc.claim_fixer("tok-b", "h2", vec![], Row::Missing, 200),
            FixerClaim::Held("tok-a".into())
        );
        assert!(doc.fixer_started("tok-a", "app-1-tok-a"));
        assert_eq!(
            doc.claim_fixer("tok-b", "h2", vec![], Row::Open, 300),
            FixerClaim::Held("tok-a".into())
        );
        // Settled: the next claim takes over.
        assert_eq!(
            doc.claim_fixer("tok-b", "h2", vec!["y".into()], Row::Settled, 400),
            FixerClaim::Claimed
        );
        let fixer = doc.fixer.as_ref().unwrap();
        assert_eq!(
            (fixer.token.as_str(), fixer.items.clone()),
            ("tok-b", vec!["y".to_string()])
        );
        assert!(
            fixer.child_session.is_empty(),
            "the new task has not started yet"
        );
    }

    #[test]
    fn a_fixer_claim_that_never_became_a_task_is_taken_over_after_the_grace() {
        let mut doc = Doc::default();
        doc.claim_fixer("tok-a", "h", vec![], Row::Missing, 1_000);
        assert!(doc.fixer_held(Row::Missing, 1_000 + CLAIM_GRACE_MS - 1));
        assert!(!doc.fixer_held(Row::Missing, 1_000 + CLAIM_GRACE_MS));
        assert_eq!(
            doc.claim_fixer("tok-b", "h", vec![], Row::Missing, 1_000 + CLAIM_GRACE_MS),
            FixerClaim::Claimed
        );
    }

    #[test]
    fn only_the_claim_that_was_made_is_given_back_or_started_or_finished() {
        let mut doc = Doc::default();
        doc.claim_fixer("tok-a", "h", vec![], Row::Missing, 1);
        assert!(!doc.release_fixer("tok-other"));
        assert!(!doc.fixer_started("tok-other", "app-1-x"));
        assert!(doc.fixer.is_some());
        assert!(doc.fixer_started("tok-a", "app-1-tok-a"));
        assert!(
            doc.fixer_done("app-1-other").is_none(),
            "another task's report does not free the slot"
        );
        assert!(doc.fixer_done("").is_none());
        assert!(doc.fixer.is_some());
        assert!(doc.fixer_done("app-1-tok-a").is_some());
        assert!(doc.fixer.is_none());
        doc.claim_fixer("tok-c", "h", vec![], Row::Missing, 2);
        assert!(doc.release_fixer("tok-c"));
        assert!(doc.fixer.is_none());
    }

    #[test]
    fn a_fixer_that_finished_before_its_child_session_was_recorded_is_still_known_by_its_request_id(
    ) {
        let mut doc = Doc::default();
        doc.claim_fixer(
            "test-fixer-0123456-99",
            "h",
            vec!["x".into()],
            Row::Missing,
            1,
        );
        // Not recorded yet: the task is `app-<chat>-<token>`.
        assert!(doc.is_fixer("app-chat-7-test-fixer-0123456-99"));
        assert!(
            !doc.is_fixer("app-chat-7-test-fixer-0123456-98"),
            "another task's"
        );
        assert!(!doc.is_fixer("app-chat-7-other"));
        assert!(!doc.is_fixer(""));
        // Once recorded, only the recorded session is the fixer.
        doc.fixer_started("test-fixer-0123456-99", "app-chat-7-test-fixer-0123456-99");
        assert!(doc.is_fixer("app-chat-7-test-fixer-0123456-99"));
        assert!(!doc.is_fixer("app-chat-8-test-fixer-0123456-99"));
        assert!(doc.fixer_done("app-chat-7-test-fixer-0123456-99").is_some());
    }

    #[test]
    fn a_document_read_from_disk_is_made_sane() {
        let mut doc = Doc::default();
        let mut item = Item {
            id: "vitest|a|t".into(),
            name: "t".into(),
            failure: "f".repeat(5_000),
            ..Item::default()
        };
        item.seen_count = 0;
        doc.items.push(item.clone());
        doc.items.push(item); // a duplicate id
        doc.items.push(Item::default()); // no id
        doc.asked.push(Asked {
            id: "x".into(),
            at: 1,
            answer: Some("sure".into()),
        });
        doc.fixer = Some(Fixer::default()); // no child session
        let doc = doc.sane();
        assert_eq!(doc.items.len(), 1);
        assert_eq!(doc.items[0].failure.chars().count(), FAILURE_MAX);
        assert_eq!(doc.items[0].seen_count, 1);
        assert_eq!(
            doc.asked[0].answer, None,
            "an answer this build does not know is no answer"
        );
        assert!(doc.fixer.is_none());
    }

    #[test]
    fn a_full_list_says_so_instead_of_dropping_quietly() {
        let mut doc = Doc::default();
        for n in 0..ITEMS_MAX {
            assert_eq!(
                doc.note_failure(&cand("a.test.ts", &format!("t{n}")), 1),
                Noted::Added
            );
        }
        assert_eq!(
            doc.note_failure(&cand("a.test.ts", "one more"), 2),
            Noted::Full
        );
        // One already on the list is still seen.
        assert_eq!(doc.note_failure(&cand("a.test.ts", "t0"), 3), Noted::Seen);
    }

    #[test]
    fn a_secret_a_test_printed_is_never_kept_in_the_failure_text() {
        let mut doc = Doc::default();
        let mut leaky = cand("a.test.ts", "t");
        leaky.failure = "expected token ghp_0123456789abcdefghijklmnopqrstuvwxyz to match\nand ANTHROPIC sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123".into();
        doc.note_failure(&leaky, 1);
        let text = &doc.items[0].failure;
        assert!(!text.contains("ghp_0123"), "{text}");
        assert!(!text.contains("sk-ant-api03"), "{text}");
        assert!(
            text.contains("expected token"),
            "what is not secret stays: {text}"
        );
        // And a second sighting is scrubbed the same way.
        leaky.failure = "again ghp_0123456789abcdefghijklmnopqrstuvwxyz".into();
        doc.note_failure(&leaky, 2);
        assert!(!doc.items[0].failure.contains("ghp_0123"));
    }

    #[test]
    fn two_tests_whose_file_names_hold_a_bar_are_two_ids() {
        assert_ne!(test_id("vitest", "a|b", "c"), test_id("vitest", "a", "b|c"));
        // Whitespace around a name is not part of it.
        assert_eq!(test_id("vitest", "a", "b"), test_id("vitest", "a", "  b "));
    }

    #[test]
    fn a_workers_request_quarantines_a_test_that_was_never_listed_for_14_days_and_asking_again_starts_over(
    ) {
        let mut doc = Doc::default();
        let id = test_id("vitest", "src\\other.test.ts", "suite > works");
        doc.quarantine_test(
            &id,
            "suite > works",
            "src\\other.test.ts",
            "flaky\n on re-run",
            1_000,
        );
        assert_eq!(doc.quarantine.len(), 1);
        let entry = &doc.quarantine[0];
        assert_eq!(entry.id, id);
        assert_eq!(entry.file, "src/other.test.ts");
        assert_eq!(entry.reason, "flaky on re-run");
        assert_eq!(entry.ends_at, 1_000 + QUARANTINE_MS);
        assert!(doc.quarantined(&id, 1_000 + QUARANTINE_MS - 1));
        assert!(!doc.quarantined(&id, 1_000 + QUARANTINE_MS));
        // Never listed while it is quarantined.
        let noted = doc.note_failure(
            &Candidate {
                runner: "vitest".into(),
                file: "src/other.test.ts".into(),
                name: "suite > works".into(),
                failure: "boom".into(),
                command: "npx vitest run".into(),
                first_commit: "abc1234".into(),
                delegation_id: "d1".into(),
                task_title: "t".into(),
            },
            2_000,
        );
        assert_eq!(noted, Noted::Quarantined);
        assert!(doc.items.is_empty());
        // Asking again is one entry with a new end date, not two.
        doc.quarantine_test(&id, "suite > works", "src/other.test.ts", "again", 9_000);
        assert_eq!(doc.quarantine.len(), 1);
        assert_eq!(doc.quarantine[0].ends_at, 9_000 + QUARANTINE_MS);
        // A secret in the worker's words is never kept.
        let mut leaky = Doc::default();
        leaky.quarantine_test(
            "y",
            "n",
            "f",
            "flaky, saw ghp_0123456789abcdefghijklmnopqrstuvwxyz in the log",
            1,
        );
        assert!(
            !leaky.quarantine[0].reason.contains("ghp_0123"),
            "{}",
            leaky.quarantine[0].reason
        );
        assert!(leaky.quarantine[0].reason.starts_with("flaky, saw"));
        // A test already on the list stays there until it is sorted.
        let mut listed = Doc::default();
        listed.items.push(Item {
            id: "x".into(),
            ..Item::default()
        });
        listed.quarantine_test("x", "n", "f", "r", 1);
        assert_eq!(listed.items.len(), 1);
        assert!(listed.quarantined("x", 2));
    }

    #[test]
    fn a_full_quarantine_lets_the_soonest_ending_go_and_still_quarantines_the_new_one() {
        let mut doc = Doc::default();
        for n in 0..QUARANTINE_MAX {
            doc.quarantine.push(Quarantined {
                id: format!("old-{n}"),
                added_at: 1_000 + n as u64,
                ends_at: 1_000 + n as u64 + QUARANTINE_MS,
                ..Quarantined::default()
            });
        }
        doc.note_failure(&cand("a.test.ts", "newly flaky"), 5_000);
        let id = doc.items[0].id.clone();
        assert!(doc.mark_flaky(&id, "passed on a re-run", 5_000));
        assert_eq!(doc.quarantine.len(), QUARANTINE_MAX);
        assert!(doc.quarantined(&id, 5_001), "the new one is quarantined");
        assert!(
            !doc.quarantine.iter().any(|q| q.id == "old-0"),
            "the one ending soonest made room"
        );
    }

    #[test]
    fn a_bug_is_not_credited_as_caught_when_its_test_is_gone() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a.test.ts", "t"), 1);
        let id = doc.items[0].id.clone();
        doc.mark_code_wrong(&id, "real", 2);
        // The command went green because the test was deleted: it left the list, and caught nothing.
        let gone = doc.remove_green_with(|_| true, |_| false);
        assert_eq!(gone.len(), 1);
        assert_eq!((doc.score[0].broke, doc.score[0].caught), (1, 0));
    }

    #[test]
    fn ids_use_forward_slashes_so_a_windows_path_is_the_same_test() {
        assert_eq!(
            test_id("vitest", "src\\a.test.ts", "t"),
            test_id("vitest", "src/a.test.ts", "t")
        );
    }
}
