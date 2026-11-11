//! WP-215: the store refuses a captain answer the captain is not allowed to give.
//! The check is `answered_by` starting with `captain:`, not the prompt.

use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection};

const HOUR_MS: i64 = 3_600_000;
const TURN_CAP: i64 = 20;
const REASON_MAX: usize = 500;

const OWNER: &str = "Only the owner answers this. The captain cannot.";
const RED: &str = "This is on the red list, so the captain cannot answer it.";
const OFF: &str = "The captain is off for this project. It waits for the owner.";
const MONEY: &str = "Money is past the owner's limit, so the captain cannot answer it.";
const TURNS: &str = "The captain is out of turns this hour. It waits for the owner.";
const SELF: &str =
    "The captain cannot raise its own turn cap or a budget, and it cannot edit its charter.";

pub fn is_captain(by: Option<&str>) -> bool {
    by.unwrap_or("").trim().starts_with("captain:")
}

/// A key only the owner answers, after the same fold as `person_only`. `charterboard` is not the charter.
pub fn owner_key(key: &str) -> bool {
    let folded = super::fold_key(key);
    if folded == "charter" || folded == "captain-cap" {
        return true;
    }
    const PREFIXES: &[&str] = &[
        "irreversible/",
        "fresh-eyes/",
        "fresh-eyes-start/",
        "fanout-again/",
        "gate/",
        "secret/",
        "security/",
        "charter/",
        "captain-cap/",
        "budget/",
    ];
    PREFIXES.iter().any(|prefix| folded.starts_with(prefix))
}

fn self_key(key: &str) -> bool {
    let folded = super::fold_key(key);
    folded == "charter"
        || folded == "captain-cap"
        || folded.starts_with("charter/")
        || folded.starts_with("captain-cap/")
        || folded.starts_with("budget/")
}

/// Refuses a captain answer on an owner's key before any lookup, so a missing row is still an error.
pub fn refuse_key(key: &str, by: Option<&str>) -> Option<String> {
    if !is_captain(by) || !owner_key(key) {
        return None;
    }
    Some(if self_key(key) { SELF } else { OWNER }.to_string())
}

pub fn clip_reason(reason: Option<&str>) -> Option<String> {
    let text = reason?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(REASON_MAX).collect())
}

/// Inside the answer's transaction, once the stored row is loaded. A read that fails is a refusal.
pub fn refuse_stored(
    conn: &Connection,
    decision: &super::Decision,
    by: Option<&str>,
    proposed: &str,
    reason: Option<&str>,
    now: i64,
) -> Result<Option<String>, String> {
    if !is_captain(by) {
        return Ok(None);
    }
    if owner_key(&decision.decision_key) {
        return Ok(Some(
            if self_key(&decision.decision_key) {
                SELF
            } else {
                OWNER
            }
            .to_string(),
        ));
    }
    // The question and the answer are judged. The reason is not: it can name the red line it is passing up.
    let text = format!("{}\n{proposed}", decision.question);
    if red_category(&text).is_some() {
        return Ok(Some(RED.to_string()));
    }
    if !switch_on(conn, &decision.project, now)? {
        return Ok(Some(OFF.to_string()));
    }
    if spend_blocked(conn, &decision.project, now) {
        return Ok(Some(MONEY.to_string()));
    }
    let counted = clip_reason(reason).is_some_and(|text| text.starts_with("captain turn:"));
    if counted && turns_full(conn, &decision.project, now)? {
        return Ok(Some(TURNS.to_string()));
    }
    Ok(None)
}

fn switch_on(conn: &Connection, project: &str, now: i64) -> Result<bool, String> {
    let switches = crate::autopilot::active_switches(conn, now).map_err(|_| OFF.to_string())?;
    Ok(switches
        .iter()
        .any(|switch| switch.scope == "*" || switch.scope == project))
}

fn spend_blocked(conn: &Connection, project: &str, now: i64) -> bool {
    // No book is fine. A limit that is reached, or a book that cannot be read, holds the answer.
    crate::spend_ledger::admit_automated(conn, Some(project), now).is_err()
}

fn turns_full(conn: &Connection, project: &str, now: i64) -> Result<bool, String> {
    let since = now.saturating_sub(HOUR_MS);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM decisions
              WHERE project = ?1
                AND answered_by LIKE 'captain:%'
                AND answer_reason LIKE 'captain turn:%'
                AND answered_at > ?2",
            params![project, since],
            |row| row.get(0),
        )
        .map_err(|_| {
            "The captain could not count its turns, so it waits for the owner.".to_string()
        })?;
    Ok(count >= TURN_CAP)
}

/// A first mate's note: already answered, in its own chat. Not a captain answer, and not gated by the switch.
pub fn note(
    conn: &mut Connection,
    project: &str,
    session: &str,
    what: &str,
    reason: &str,
    now: i64,
) -> Result<super::Decision, String> {
    let project = project.trim();
    if project.is_empty() || project.chars().count() > 128 {
        return Err("The project is empty.".into());
    }
    let session = session.trim();
    if session.is_empty() {
        return Err("The chat is empty.".into());
    }
    let what = super::plain(what, "What was decided", super::ANSWER_MAX)?;
    let reason = super::plain(reason, "The reason", REASON_MAX)?;
    if owner_key(&what) {
        return Err(OWNER.to_string());
    }
    let by = format!("chat:{session}");
    let by: String = by.chars().take(120).collect();
    let asked_by: String = session.chars().take(120).collect();
    let tag = session_tag(session);
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut saved = None;
    for n in 0..8 {
        let key = format!("noted/{tag}-{now}-{n}");
        if super::get(&tx, project, &key)?.is_some() {
            continue;
        }
        super::save(
            &tx,
            &super::Decision {
                project: project.to_string(),
                decision_key: key.clone(),
                question: what.clone(),
                options: Vec::new(),
                recommended: None,
                asked_by: asked_by.clone(),
                asked_by_mono: None,
                waiting: Vec::new(),
                state: super::ANSWERED.to_string(),
                answer: Some(what.clone()),
                answered_by: Some(by.clone()),
                answered_at: Some(now),
                created_at: now,
                updated_at: now,
                version: 1,
                standing: false,
                keys: Vec::new(),
                retired_at: None,
                retired_reason: None,
                reuse_stopped: false,
                force_reason: None,
                answer_reason: Some(reason.clone()),
                standing_id: String::new(),
            },
        )?;
        saved = super::get(&tx, project, &key)?;
        break;
    }
    let Some(saved) = saved else {
        return Err("The note could not be written.".into());
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}

fn session_tag(session: &str) -> String {
    let tag: String = session
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    if tag.is_empty() {
        "chat".into()
    } else {
        tag
    }
}

// The same patterns as autopilot/model/redList.ts, matched on lower-cased text with whitespace collapsed.
// A pattern that does not compile makes its category always match, so a broken list holds rather than lets one through.
const PATTERNS: &[(&str, &[&str])] = &[
    (
        "money",
        &[
            r"\brefund(s|ed|ing)?\b",
            r"\bcharge ?backs?\b",
            r"\bcharg(e|es|ed|ing) (the |a |an |their |his |her |every |each |all )?(customer|user|client|buyer|account|card|subscriber)s?\b",
            r"\b(re)?charg(e|ing) (them|him|her)\b",
            r"\bpayouts?\b",
            r"\bwire (transfer|money|funds)\b",
            r"\b(send|move|transfer|withdraw|deposit|pay|bridge|swap)(s|ed|ing)? (the |some |all |their |his |her )?(money|funds|usdc|eth|btc|crypto|\$\s?\d)",
            r"\bwithdraw(al|als|ing)?\b.{0,30}\b(wallet|funds|account|balance|usdc)\b",
            r"\b(issue|grant|apply|give) (a |an )?(credit|discount|coupon|comp|free month)s?\b.{0,30}\b(customer|user|account|subscription)",
            r"\bstripe\b.{0,40}\b(refund|charge|payout|transfer|invoice|subscription|coupon|credit|price)",
            r"\b(cancel|upgrade|downgrade|change) (their|the customer'?s?|a user'?s?|his|her) (plan|subscription|billing)\b",
            r"\b(top[- ]?up|credit) (their|the|a) (balance|account|wallet)\b",
            r"\bmove money\b",
        ],
    ),
    (
        "delete",
        &[
            r"\brm\s+(-[a-z]*r[a-z]*|--recursive)\b",
            r"\brm\s+-[a-z]*f[a-z]*\s+\S*[*~]",
            r"\bfind\b.{0,80}\s-delete\b",
            r"\bdrop\s+(table|database|schema|index|column)\b",
            r"\btruncate\s+(table\s+)?\w",
            r"\bdelete\s+from\b",
            r"\b(delete|deleting|deleted|drop|dropping|wipe|wiping|purge|purging|erase|erasing|destroy|destroying|nuke|nuking)\b.{0,40}\b(data|database|databases|db|dbs|tables?|records?|rows?|users?|accounts?|customers?|buckets?|backups?|snapshots?|volumes?|disks?|vms?|instances?|servers?|history|chats?|conversations?|transcripts?|memor(y|ies)|emails?|inbox|messages|worktrees?|data ?folder|storage|uploads?|logs)\b",
            r"\b(remove|removing|clear|clearing|reset|resetting)\b.{0,30}\b(database|databases|db|backups?|snapshots?|volumes?|vms?|instances?|servers?|accounts?|customers?|data ?folder|buckets?|storage|production data|user data|customer data|live data)\b",
            r"\bgit\s+clean\s+-[a-z]*f|\bgit\s+branch\s+-[a-z]*d|\bgit\s+worktree\s+remove\b|\bgit\s+stash\s+(drop|clear)\b|\bgit\s+reflog\s+expire\b",
            r"\bsqlite3?\b.{0,80}\b(delete|drop|truncate)\b",
            r"\b(supabase|psql|mysql|mongo)\b.{0,80}\b(delete|drop|truncate|reset)\b",
        ],
    ),
    (
        "prod-host",
        &[
            r"\bprod(uction)?\b.{0,40}\b(host|server|box|boxes|vm|vms|machine|node|cluster|db|database|deploy|deployment|maintenance|restart|reboot|migration|migrate|promote|rollout|roll out|upgrade|patch|failover|dns|caddy|nginx|firewall)\b",
            r"\b(host|server|vm|database|db|deploy|deployment|maintenance|restart|reboot|migration|promote|rollout|upgrade)\b.{0,30}\b(on|in|to) prod(uction)?\b",
            r"\b(ssh|scp|rsync|mosh)\b.{0,80}\b(prod|production|root@|pve\d*|proxmox|hetzner)",
            r"\b(proxmox|pve\d+|hetzner|qm (stop|start|destroy|reboot|set|migrate)|pct (stop|destroy|reboot))\b",
            r"\b(sudo\s+)?(reboot|poweroff)\b|\bshutdown\s+-[hr]\b",
            r"\bsystemctl\s+(restart|stop|disable|reboot|poweroff)\b",
            r"\bvercel\b.{0,40}(--prod\b|\bpromote\b|\brollback\b)",
            r"\b(fly|flyctl| heroku|railway|render)\b.{0,40}\b(deploy|scale|restart|destroy)\b",
            r"\bmigrat(e|ion|ions)\b.{0,40}\b(prod|production|moltbot|live database|live db)\b",
            r"\bpromote (it |this |the build |canary )?to (prod|production|main)\b",
        ],
    ),
    (
        "mass-destructive",
        &[
            r"\b(all|every|each|mass|bulk|batch of)\b.{0,30}\b(delete|deleting|remove|removing|cancel|cancelling|canceling|close|closing|archive|archiving|revoke|revoking|kill|killing|drop|dropping|wipe|wiping|suspend|suspending|terminate|terminating|ban|banning|refund)\b",
            r"\b(delete|remove|cancel|close|archive|revoke|kill|drop|wipe|suspend|terminate|ban)\b.{0,20}\b(all|every|each)\b",
            r"\bgit\s+push\b.{0,40}(--force\b|-f\b|--force-with-lease\b|\+\w)",
            r"\bgit\s+reset\s+--hard\b",
            r"\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)",
            r"\b(pkill|killall)\b",
            r"\bkill\s+-9\b",
            r"\bdocker\s+(system|volume|image|container)\s+prune\b",
            r"\bkubectl\s+delete\b",
            r"\bterraform\s+(destroy|apply\s+-destroy)\b",
            r"\b(chmod|chown)\s+-r\b",
            r"\bxargs\b.{0,40}\brm\b",
        ],
    ),
    (
        "send-as-ash",
        &[
            r"\b(send|sending|post|posting|publish|publishing|tweet|tweeting|announce|announcing|broadcast|broadcasting|email|emailing|dm|dming)\b.{0,50}\b(as (ash|me|him)|on (ash'?s|his|my) behalf|from (ash'?s|his|my) (account|email|address|handle)|customers?|users?|subscribers?|clients?|everyone|the team|the community|investors?|holders?|followers?|newsletter|mailing list|slack|discord|telegram|twitter|x\.com|linkedin|instagram|tiktok|reddit|whatsapp|imessage|gmail|resend)\b",
            r"\b(reply|replying|respond|responding)\b.{0,20}\bto (the |a |that |this |their |his |her )?(customer|client|email|tweet|dm|thread|comment|review)s?\b",
            r"(gmail|slack|discord|telegram|twitter|resend|sendgrid|mailgun|postmark|whatsapp|imessage)[\w .-]{0,24}?(send|post|reply|message|broadcast)",
            r"(^|[^a-z.])(send|post)_?(message|email|mail|tweet|dm|reply)",
            r"\bgh\s+(issue|pr)\s+(comment|review|close)\b",
            r"\bgh\s+api\b.{0,60}\bcomments?\b",
            r"\bosascript\b.{0,80}\b(messages|mail)\b",
            r"\b(customer|subscriber|holder)s? (notice|announcement|newsletter|broadcast|email blast)\b",
        ],
    ),
    (
        "credentials",
        &[
            r"\b(api|secret|access|private|signing|service[- ]role|anon) ?keys?\b",
            r"\b(client|webhook|jwt|app) secrets?\b",
            r"\bpass(word|words|phrase|code)s?\b",
            r"\bcredentials?\b",
            r"\b(access|auth|bearer|refresh|session|github|gh|npm|pat|oauth|personal access) tokens?\b",
            r"\bssh[- ]?keys?\b|\bid_(rsa|ed25519)\b|\.pem\b",
            r"\bkeychain(s)?\b|\bsecurity\s+(find|add|delete)-(generic|internet)-password\b",
            r"\.netrc\b|\.pgpass\b|\.pypirc\b|\.npmrc\b",
            r"\.gnupg\b|\.ssh\b|\.docker[/]config\.json|\.kube[/]config\b|\.aws[/]credentials\b",
            r"(^|[\s/])\.config[/]gh\b|gh[/]hosts\.yml\b",
            r"\bseed phrase\b|\bmnemonic\b|\bwallet (key|seed)\b",
            r"(^|[\s/'`])\.env(\.[a-z]+)?\b",
            r"\b(2fa|mfa|otp|one[- ]time (code|password)|recovery codes?)\b",
            r"\b(rotate|revoke|regenerate|share|print|paste|leak)\b.{0,30}\b(keys|secret|secrets|token|tokens|credential|credentials)\b",
        ],
    ),
];

struct Category {
    name: &'static str,
    patterns: Vec<Regex>,
    /// A pattern that did not compile. The category then matches everything.
    broken: bool,
}

fn categories() -> &'static [Category] {
    static SET: OnceLock<Vec<Category>> = OnceLock::new();
    SET.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|(name, patterns)| {
                let mut compiled = Vec::new();
                let mut broken = false;
                for pattern in *patterns {
                    match Regex::new(pattern) {
                        Ok(re) => compiled.push(re),
                        Err(_) => broken = true,
                    }
                }
                Category {
                    name,
                    patterns: compiled,
                    broken,
                }
            })
            .collect()
    })
}

fn normalize(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in text.to_lowercase().chars() {
        if c.is_whitespace() {
            if !out.is_empty() {
                space = true;
            }
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    out
}

pub fn red_category(text: &str) -> Option<&'static str> {
    let normalized = normalize(text);
    if normalized.is_empty() {
        return None;
    }
    for category in categories() {
        if category.broken
            || category
                .patterns
                .iter()
                .any(|pattern| pattern.is_match(&normalized))
        {
            return Some(category.name);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::{note, owner_key, red_category};
    use crate::delegations::{record, RecordInput};
    use crate::session_store::SessionStore;
    use crate::spend_ledger::{append, write_book, TurnEntry};
    use regex::Regex;
    use rusqlite::{params, Connection};

    const NOW: i64 = 1_700_000_000_000;

    fn store() -> SessionStore {
        SessionStore::open_in_memory().unwrap()
    }

    fn mate(conn: &mut Connection) {
        record(
            conn,
            RecordInput {
                owner_session: "fm".into(),
                request_id: "r-cap".into(),
                child_session: "w-cap".into(),
                ..Default::default()
            },
            1,
        )
        .unwrap();
    }

    fn open(conn: &mut Connection, project: &str, key: &str, question: &str) {
        ask(
            conn,
            AskInput {
                asked_by: "fm".into(),
                asked_by_mono: None,
                project: Some(project.into()),
                key: key.into(),
                question: question.into(),
                options: vec!["Keep it".into(), "Change it".into()],
                recommended: Some("Keep it".into()),
                task_ids: vec![],
                keys: vec![],
                force: false,
                reason: None,
            },
            NOW,
        )
        .unwrap();
    }

    fn cover(conn: &Connection, scope: &str) {
        conn.execute(
            "INSERT INTO autopilot_switches (scope, until_ms, set_by, set_at) VALUES (?1, ?2, 'ash', ?3)",
            params![scope, NOW + 3_600_000, NOW],
        )
        .unwrap();
    }

    fn captain_answers(
        conn: &mut Connection,
        project: &str,
        key: &str,
        answer: &str,
        reason: &str,
    ) -> Result<AnswerOutcome, String> {
        answer_with(
            conn,
            project,
            key,
            answer,
            Some("captain:ada".into()),
            Some(reason),
            NOW,
        )
    }

    #[test]
    fn every_red_list_pattern_compiles() {
        for (name, patterns) in super::PATTERNS {
            for pattern in *patterns {
                Regex::new(pattern).unwrap_or_else(|error| panic!("{name}: {pattern}: {error}"));
            }
        }
        assert_eq!(
            red_category("please refund the second charge"),
            Some("money")
        );
        assert_eq!(red_category("which name should the button use"), None);
    }

    #[test]
    fn a_captain_answer_is_refused_on_every_owner_key_including_a_folded_spelling() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        cover(&conn, "*");
        for key in [
            "irreversible/run/step",
            "fresh-eyes/run",
            "fresh-eyes-start/run",
            "fanout-again/plan/task/req",
            "gate/run",
            "secret/token",
            "security/login",
            "\u{FF33}ecret/token",
            "SECRET/other",
            "budget/raise",
            "charter",
            "captain-cap",
        ] {
            let err = captain_answers(&mut conn, "hivra", key, "the-captain-pick", "because")
                .unwrap_err();
            assert!(
                err.contains("captain") || err.contains("owner") || err.contains("person"),
                "{key}: {err}"
            );
            // The refusal names the kind. It does not repeat the proposed answer, or a secret the key held.
            assert!(
                !err.contains("the-captain-pick") && !err.contains("token"),
                "{key} echoed the answer: {err}"
            );
        }
        // A word that only starts like the charter is an ordinary question.
        open(&mut conn, "hivra", "charterboard", "Example: which name?");
        let ok = captain_answers(
            &mut conn,
            "hivra",
            "charterboard",
            "Keep it",
            "standing answer: merge on green",
        )
        .unwrap();
        assert!(ok.applied);
    }

    #[test]
    fn a_captain_answer_is_refused_on_a_red_list_question_and_the_row_stays_open() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        cover(&conn, "*");
        open(&mut conn, "hivra", "refund", "Refund the second charge?");
        let err = captain_answers(
            &mut conn,
            "hivra",
            "refund",
            "Keep it",
            "standing answer: merge on green",
        )
        .unwrap_err();
        assert!(err.contains("red list"), "{err}");
        assert!(!err.contains("second charge"), "{err}");
        let row = get(&conn, "hivra", "refund").unwrap().unwrap();
        assert_eq!(row.state, OPEN);
        let person = answer(
            &mut conn,
            "hivra",
            "refund",
            "Keep it",
            Some("person".into()),
            NOW,
        )
        .unwrap();
        assert!(person.applied);
    }

    #[test]
    fn a_captain_answer_is_refused_when_the_switch_is_off_and_a_person_answer_is_not() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        open(&mut conn, "hivra", "font", "Example: which name?");
        let err = captain_answers(
            &mut conn,
            "hivra",
            "font",
            "Keep it",
            "standing answer: merge on green",
        )
        .unwrap_err();
        assert!(err.contains("off"), "{err}");
        let person = answer(
            &mut conn,
            "hivra",
            "font",
            "Keep it",
            Some("person".into()),
            NOW,
        )
        .unwrap();
        assert!(person.applied);
        assert_eq!(person.decision.unwrap().answer_reason, None);
    }

    #[test]
    fn a_switch_for_one_project_does_not_cover_another() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        cover(&conn, "exo");
        open(&mut conn, "hivra", "font", "Example: which name?");
        open(&mut conn, "exo", "font", "Example: which name?");
        assert!(captain_answers(&mut conn, "hivra", "font", "Keep it", "rule: name").is_err());
        let exo = captain_answers(&mut conn, "exo", "font", "Keep it", "rule: name").unwrap();
        assert!(exo.applied);
        assert_eq!(
            exo.decision.as_ref().unwrap().answered_by.as_deref(),
            Some("captain:ada")
        );
        assert_eq!(
            exo.decision.as_ref().unwrap().answer_reason.as_deref(),
            Some("rule: name")
        );
    }

    #[test]
    fn a_captain_answer_stores_who_and_why_when_the_switch_covers_the_project() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        cover(&conn, "*");
        open(&mut conn, "hivra", "font", "Example: which name?");
        let out = captain_answers(
            &mut conn,
            "hivra",
            "font",
            "Keep it",
            "standing answer: merge on green",
        )
        .unwrap();
        assert!(out.applied);
        let row = out.decision.unwrap();
        assert_eq!(row.answered_by.as_deref(), Some("captain:ada"));
        assert_eq!(
            row.answer_reason.as_deref(),
            Some("standing answer: merge on green")
        );
        assert!(!row.standing);
    }

    #[test]
    fn money_past_the_limit_is_refused_and_the_twenty_first_turn_is_refused() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        mate(&mut conn);
        cover(&conn, "*");
        write_book(
            &conn,
            0,
            1,
            r#"{"revision":1,"limits":[{"scope":"app","period":"month","amountUsd":1,"warnAt":0.8}],"ceilings":{}}"#,
        )
        .unwrap();
        append(
            &conn,
            &TurnEntry {
                session_id: "s".into(),
                project_key: "hivra".into(),
                at: NOW,
                micros: 2_000_000,
                priced: true,
                source: None,
            },
        )
        .unwrap();
        open(&mut conn, "hivra", "spend", "Example: which name?");
        let err =
            captain_answers(&mut conn, "hivra", "spend", "Keep it", "rule: name").unwrap_err();
        assert!(err.contains("Money") || err.contains("limit"), "{err}");

        // A book under the limit still counts turns. Replace it with a high ceiling.
        write_book(
            &conn,
            1,
            2,
            r#"{"revision":2,"limits":[{"scope":"app","period":"month","amountUsd":100,"warnAt":0.8}],"ceilings":{}}"#,
        )
        .unwrap();
        for n in 0..20 {
            let key = format!("turn-{n}");
            open(&mut conn, "hivra", &key, "Example: which name?");
            let out = captain_answers(&mut conn, "hivra", &key, "Keep it", "captain turn: shorter")
                .unwrap();
            assert!(out.applied, "{n}");
        }
        open(&mut conn, "hivra", "turn-20", "Example: which name?");
        let capped = captain_answers(
            &mut conn,
            "hivra",
            "turn-20",
            "Keep it",
            "captain turn: again",
        )
        .unwrap_err();
        assert!(capped.contains("turns"), "{capped}");
        // The 20 turns also filled the worker's steering queue. That queue is not the captain's cap.
        conn.execute(
            "UPDATE steer_messages SET state = 'delivered' WHERE state = 'pending'",
            [],
        )
        .unwrap();
        // A standing answer is not a turn, so the cap does not hold it.
        let standing = captain_answers(
            &mut conn,
            "hivra",
            "turn-20",
            "Keep it",
            "standing answer: merge on green",
        )
        .unwrap();
        assert!(standing.applied);
    }

    #[test]
    fn a_note_is_the_first_mates_chat_and_cannot_answer_an_owner_key() {
        let store = store();
        let mut conn = store.lock_conn().unwrap();
        let saved = note(
            &mut conn,
            "hivra",
            "lead-1",
            "Example: merge on green",
            "the checks passed",
            NOW,
        )
        .unwrap();
        assert_eq!(saved.answered_by.as_deref(), Some("chat:lead-1"));
        assert_eq!(saved.answer_reason.as_deref(), Some("the checks passed"));
        assert_eq!(saved.state, ANSWERED);
        assert!(saved.decision_key.starts_with("noted/"));
        assert!(!saved.standing);
        let again = note(
            &mut conn,
            "hivra",
            "lead-1",
            "Example: retry once",
            "the build failed",
            NOW,
        )
        .unwrap();
        assert_ne!(again.decision_key, saved.decision_key);
        let err = note(&mut conn, "hivra", "lead-1", "secret/token", "because", NOW).unwrap_err();
        assert!(err.contains("owner") || err.contains("captain"), "{err}");
        assert!(note(
            &mut conn,
            "hivra",
            "  ",
            "Example: retry once",
            "because",
            NOW
        )
        .is_err());
    }

    #[test]
    fn charterboard_is_not_an_owner_key() {
        assert!(!owner_key("charterboard"));
        assert!(owner_key("charter"));
        assert!(owner_key("CHARTER"));
        assert!(owner_key("budget/raise"));
    }
}
