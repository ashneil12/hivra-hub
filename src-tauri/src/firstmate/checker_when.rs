//! PT-4: "When the checker runs" (the app setting beside "Who checks the work", `checker_family`).
//!
//! The running checker (SC-5: a model from another family that re-runs the brief's check lines in a read-only copy) is the
//! strongest read a finished task or a ship check gets, and it costs about two model calls from another family. Which tasks
//! get it is the app's own setting, kept in the app's database (`checker_settings`, `checker_when_rule`) and never read from a
//! project's files:
//!
//! | Rule | Per task | The ship check's review |
//! | --- | --- | --- |
//! | `follow-mode` (default) | `at-ship` and `light`: a risky change; `full`: every code change | the running checker |
//! | `every-code-change` | every code change in `at-ship`, `light` and `full` (and a risky one that isn't code) | the running checker |
//! | `risky-only` | a risky change, in every mode | the one-turn review |
//! | `off` | never: the cheap one-turn check only | the one-turn review |
//!
//! "No testing" (`TestingMode::Off`) runs no checker whatever this says, per task and at the ship check. A value this build
//! doesn't know, a missing row or a table that can't be read is the default, never a stricter or a looser surprise. The
//! default is ONE constant, `DEFAULT_WHEN_RULE`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::checker_family;
use super::testing_mode::Checker;
use crate::delivery::settings::TestingMode;

/// The key of the rule in the app's `checker_settings` table (beside `checker_family_rule`).
pub const RULE_KEY: &str = "checker_when_rule";

/// What a person who never chose gets: the running checker follows the project's testing mode. The one line to change if
/// another default is wanted.
pub const DEFAULT_WHEN_RULE: WhenRule = WhenRule::FollowMode;

/// When the running checker is used.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WhenRule {
    /// The testing mode decides (see the table above).
    FollowMode,
    /// Every code change gets it, in every mode but "No testing".
    EveryCodeChange,
    /// Only a change to a protected or security path gets it.
    RiskyOnly,
    /// Never: the cheap one-turn check only.
    Off,
}

impl Default for WhenRule {
    fn default() -> WhenRule {
        DEFAULT_WHEN_RULE
    }
}

impl WhenRule {
    /// The four rules, in the order a person is shown them. Only tests walk them.
    #[cfg(test)]
    pub const ALL: [WhenRule; 4] = [
        WhenRule::FollowMode,
        WhenRule::EveryCodeChange,
        WhenRule::RiskyOnly,
        WhenRule::Off,
    ];

    pub fn word(self) -> &'static str {
        match self {
            WhenRule::FollowMode => "follow-mode",
            WhenRule::EveryCodeChange => "every-code-change",
            WhenRule::RiskyOnly => "risky-only",
            WhenRule::Off => "off",
        }
    }

    /// A stored or sent word. Anything this build doesn't know is not a rule.
    pub fn parse(word: &str) -> Option<WhenRule> {
        match word.trim().to_ascii_lowercase().as_str() {
            "follow-mode" => Some(WhenRule::FollowMode),
            "every-code-change" => Some(WhenRule::EveryCodeChange),
            "risky-only" => Some(WhenRule::RiskyOnly),
            "off" => Some(WhenRule::Off),
            _ => None,
        }
    }
}

// ---- the decision -------------------------------------------------------------------------------------------------------

/// Which model reads a finished task's claims. `code_changed` is whether the diff has any code in it and `risky` whether it
/// touches a protected or security path (both are true when the diff couldn't be read, so the stricter check runs and says so).
///
/// "No testing" is never a checker. Otherwise a mode that has a cheap check for a task it doesn't run the checker on keeps it
/// (`light` and `full`); `at-ship` has none, so such a task has no verdict model, as before.
pub fn task_checker(rule: WhenRule, mode: TestingMode, code_changed: bool, risky: bool) -> Checker {
    if mode == TestingMode::Off {
        return Checker::None;
    }
    let cheap_or_none = match mode {
        TestingMode::AtShip => Checker::None,
        _ => Checker::Cheap,
    };
    let running = match rule {
        // Today's per-task behaviour: a risky change, and in `full` every code change.
        WhenRule::FollowMode => risky || (mode == TestingMode::Full && code_changed),
        WhenRule::EveryCodeChange => risky || code_changed,
        WhenRule::RiskyOnly => risky,
        WhenRule::Off => false,
    };
    if running {
        Checker::Running
    } else if rule == WhenRule::Off && risky && mode == TestingMode::AtShip {
        // The cheap one-turn check is all this rule allows, and a risky change is at least read by it.
        Checker::Cheap
    } else {
        cheap_or_none
    }
}

/// Whether the ship check's review step is the running checker (another family, the briefs' check lines re-run on a read-only
/// copy of HEAD) rather than the one-turn verdict. Never in "No testing".
pub fn ship_review_runs(rule: WhenRule, mode: TestingMode) -> bool {
    mode != TestingMode::Off && matches!(rule, WhenRule::FollowMode | WhenRule::EveryCodeChange)
}

// ---- the setting --------------------------------------------------------------------------------------------------------

/// The rule. A missing row, an unreadable table or a word this build doesn't know (a newer build wrote it) is the default.
pub fn rule_of(conn: &Connection) -> WhenRule {
    let stored: Option<String> = checker_family::ensure_tables(conn)
        .ok()
        .and_then(|_| {
            conn.query_row(
                "SELECT value FROM checker_settings WHERE key = ?1",
                params![RULE_KEY],
                |row| row.get(0),
            )
            .optional()
            .ok()
        })
        .flatten();
    stored
        .as_deref()
        .and_then(WhenRule::parse)
        .unwrap_or_default()
}

/// Sets the rule. The person's latest choice wins: it is one value written whole, not changed from a value read earlier.
pub fn set_rule(conn: &Connection, rule: WhenRule) -> Result<(), String> {
    checker_family::ensure_tables(conn).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO checker_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RULE_KEY, rule.word()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The rule, for the Settings screen.
#[tauri::command(async)]
pub fn checker_when_rule_get(
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<WhenRule, String> {
    Ok(rule_of(&*store.lock_conn()?))
}

/// Sets the rule from a word the webview sent. A word this build doesn't know is refused, never stored.
#[tauri::command(async)]
pub fn checker_when_rule_set(
    store: tauri::State<'_, crate::session_store::SessionStore>,
    rule: String,
) -> Result<WhenRule, String> {
    let rule = WhenRule::parse(&rule)
        .ok_or("The rule is \"follow-mode\", \"every-code-change\", \"risky-only\" or \"off\".")?;
    set_rule(&*store.lock_conn()?, rule)?;
    Ok(rule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Checker::{Cheap, None as NoChecker, Running};

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    const MODES: [TestingMode; 4] = TestingMode::ALL;

    #[test]
    fn the_default_is_follow_the_testing_mode_and_is_one_constant() {
        assert_eq!(DEFAULT_WHEN_RULE, WhenRule::FollowMode);
        assert_eq!(WhenRule::default(), DEFAULT_WHEN_RULE);
        // Nothing saved is the default, and so is a table that doesn't exist yet.
        assert_eq!(rule_of(&conn()), DEFAULT_WHEN_RULE);
    }

    #[test]
    fn no_testing_runs_no_checker_whatever_the_rule_says() {
        for rule in WhenRule::ALL {
            for (code, risky) in [(false, false), (true, false), (false, true), (true, true)] {
                assert_eq!(
                    task_checker(rule, TestingMode::Off, code, risky),
                    NoChecker,
                    "{rule:?} code={code} risky={risky}"
                );
            }
            assert!(!ship_review_runs(rule, TestingMode::Off), "{rule:?}");
        }
    }

    #[test]
    fn follow_the_testing_mode_keeps_what_each_mode_did_before() {
        use WhenRule::FollowMode as F;
        // Test at ship: a risky change only.
        assert_eq!(task_checker(F, TestingMode::AtShip, true, false), NoChecker);
        assert_eq!(
            task_checker(F, TestingMode::AtShip, false, false),
            NoChecker
        );
        assert_eq!(task_checker(F, TestingMode::AtShip, true, true), Running);
        // Light: a risky change only; the rest keeps the cheap check.
        assert_eq!(task_checker(F, TestingMode::Light, true, false), Cheap);
        assert_eq!(task_checker(F, TestingMode::Light, false, false), Cheap);
        assert_eq!(task_checker(F, TestingMode::Light, true, true), Running);
        // Full: every code change.
        assert_eq!(task_checker(F, TestingMode::Full, true, false), Running);
        assert_eq!(task_checker(F, TestingMode::Full, false, false), Cheap);
        assert_eq!(task_checker(F, TestingMode::Full, false, true), Running);
    }

    #[test]
    fn every_code_change_gives_every_code_diff_the_checker_in_every_mode_but_no_testing() {
        use WhenRule::EveryCodeChange as E;
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            assert_eq!(task_checker(E, mode, true, false), Running, "{mode:?} code");
            assert_eq!(
                task_checker(E, mode, true, true),
                Running,
                "{mode:?} risky code"
            );
            // A risky change that isn't code (a protected document) is still read by it.
            assert_eq!(
                task_checker(E, mode, false, true),
                Running,
                "{mode:?} risky doc"
            );
        }
        // A docs-only change keeps what the mode does for it.
        assert_eq!(
            task_checker(E, TestingMode::AtShip, false, false),
            NoChecker
        );
        assert_eq!(task_checker(E, TestingMode::Light, false, false), Cheap);
        assert_eq!(task_checker(E, TestingMode::Full, false, false), Cheap);
    }

    #[test]
    fn only_risky_changes_is_a_risky_change_in_every_mode() {
        use WhenRule::RiskyOnly as R;
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            assert_eq!(task_checker(R, mode, true, true), Running, "{mode:?}");
            assert_ne!(task_checker(R, mode, true, false), Running, "{mode:?} code");
        }
        assert_eq!(task_checker(R, TestingMode::AtShip, true, false), NoChecker);
        assert_eq!(task_checker(R, TestingMode::Light, true, false), Cheap);
        assert_eq!(task_checker(R, TestingMode::Full, true, false), Cheap);
    }

    #[test]
    fn off_is_the_cheap_one_turn_check_only_and_never_the_running_one() {
        for mode in MODES {
            for (code, risky) in [(false, false), (true, false), (false, true), (true, true)] {
                assert_ne!(
                    task_checker(WhenRule::Off, mode, code, risky),
                    Running,
                    "{mode:?} code={code} risky={risky}"
                );
            }
        }
        assert_eq!(
            task_checker(WhenRule::Off, TestingMode::Light, true, true),
            Cheap
        );
        assert_eq!(
            task_checker(WhenRule::Off, TestingMode::Full, true, false),
            Cheap
        );
        // Test at ship runs no verdict on an ordinary task, and the cheap one on a risky change.
        assert_eq!(
            task_checker(WhenRule::Off, TestingMode::AtShip, true, false),
            NoChecker
        );
        assert_eq!(
            task_checker(WhenRule::Off, TestingMode::AtShip, true, true),
            Cheap
        );
    }

    #[test]
    fn the_ship_checks_review_runs_the_checker_for_the_first_two_rules_only() {
        for mode in [TestingMode::AtShip, TestingMode::Light, TestingMode::Full] {
            assert!(ship_review_runs(WhenRule::FollowMode, mode), "{mode:?}");
            assert!(
                ship_review_runs(WhenRule::EveryCodeChange, mode),
                "{mode:?}"
            );
            assert!(!ship_review_runs(WhenRule::RiskyOnly, mode), "{mode:?}");
            assert!(!ship_review_runs(WhenRule::Off, mode), "{mode:?}");
        }
    }

    #[test]
    fn a_saved_choice_is_kept_and_read_back_whatever_the_default_is() {
        let conn = conn();
        for rule in WhenRule::ALL {
            set_rule(&conn, rule).unwrap();
            assert_eq!(rule_of(&conn), rule);
        }
        // The latest choice wins: one value, written whole.
        set_rule(&conn, WhenRule::RiskyOnly).unwrap();
        set_rule(&conn, WhenRule::EveryCodeChange).unwrap();
        assert_eq!(rule_of(&conn), WhenRule::EveryCodeChange);
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM checker_settings WHERE key = ?1",
                params![RULE_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
        // It is its own key: the family rule beside it is untouched.
        assert_eq!(
            checker_family::rule_of(&conn),
            checker_family::FamilyRule::default()
        );
    }

    #[test]
    fn a_word_this_build_does_not_know_is_the_default_and_is_never_stored() {
        let conn = conn();
        checker_family::ensure_tables(&conn).unwrap();
        for odd in ["", "everything", "EVERY-CODE", "\u{1F680}"] {
            conn.execute(
                "INSERT INTO checker_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![RULE_KEY, odd],
            )
            .unwrap();
            assert_eq!(rule_of(&conn), DEFAULT_WHEN_RULE, "{odd:?}");
        }
        assert_eq!(
            WhenRule::parse("  Every-Code-Change "),
            Some(WhenRule::EveryCodeChange)
        );
        assert_eq!(WhenRule::parse("different"), None);
        assert_eq!(WhenRule::parse(""), None);
    }

    #[test]
    fn the_words_are_kebab_case_json_the_webview_reads() {
        for rule in WhenRule::ALL {
            assert_eq!(
                serde_json::to_string(&rule).unwrap(),
                format!("\"{}\"", rule.word())
            );
            assert_eq!(WhenRule::parse(rule.word()), Some(rule));
        }
    }
}
