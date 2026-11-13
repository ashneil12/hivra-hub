//! SC-5: how a worker may dismiss a checker finding (docs/specs/shipping-confidence-gap-spec.md section 4d.4).
//!
//! A finding stands unless the worker answers it with one line in its next report:
//!
//! ```text
//! Dismiss <finding number>: <ground> - <one line why>
//! ```
//!
//! `<ground>` is one of five words (`Ground`). Any other ground, no ground, a number the last round never had, or a
//! missing reason is ignored and the finding stands: the report's text is the worker's own and never evidence. A
//! dismissal that is accepted is kept on the round's evidence with its ground, and the next running checker is told about
//! it. The checker may re-confirm the finding with a command; then it stands again (`Standing`). Where no running checker
//! looked, a dismissal changes nothing: the finding stands, and the record says nobody re-checked it.
//!
//! The five grounds are from wp-orchestration's finding ledger (a worker may dismiss a finding only on a named ground);
//! the parser and the wording are Hivra's own (its source is a prompt, with no code to take).

use serde::{Deserialize, Serialize};

/// The most dismissals read from one report.
pub const MAX_DISMISSALS: usize = 20;
/// The longest reason kept, in characters.
pub const WHY_MAX: usize = 300;
/// The highest finding number read (the numbers of one round are small; this only bounds the parse).
const NUMBER_MAX: usize = 999;

/// The only reasons a finding may be dismissed for.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Ground {
    /// The finding names nothing in the diff or the brief.
    NoBasis,
    /// The finding quotes the work or the brief wrongly.
    Misquoted,
    /// The finding is about something the brief did not ask for.
    OutsideBrief,
    /// The finding's own command or claim does not reproduce.
    NotReproduced,
    /// Acting on the finding would break something the brief says.
    ContradictsBrief,
}

impl Ground {
    /// All five, in the order the worker is told them.
    pub const ALL: [Ground; 5] = [
        Ground::NoBasis,
        Ground::Misquoted,
        Ground::OutsideBrief,
        Ground::NotReproduced,
        Ground::ContradictsBrief,
    ];

    /// The word the worker writes.
    pub fn word(self) -> &'static str {
        match self {
            Ground::NoBasis => "no-basis",
            Ground::Misquoted => "misquoted",
            Ground::OutsideBrief => "outside-brief",
            Ground::NotReproduced => "not-reproduced",
            Ground::ContradictsBrief => "contradicts-brief",
        }
    }

    /// A ground as written: the exact word, in any case. Anything else is not a ground.
    pub fn parse(text: &str) -> Option<Ground> {
        let word = text.trim().to_ascii_lowercase();
        Ground::ALL.into_iter().find(|ground| ground.word() == word)
    }
}

/// One accepted dismissal line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dismissal {
    pub number: usize,
    pub ground: Ground,
    pub why: String,
}

/// What became of a dismissed finding in the round that read the dismissal.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Standing {
    /// A running checker looked and did not re-confirm it with a command: it is let go.
    Dismissed,
    /// The checker re-confirmed it with a command: it stands. `proof` says how, in one line.
    Stands { proof: String },
    /// No running checker looked: nothing re-checked the dismissal, so the finding stands.
    NotRechecked,
}

/// A dismissed finding as the round's evidence shows it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Dismissed {
    /// The number the finding had in the round the worker answered.
    pub number: usize,
    /// The finding's own words.
    pub finding: String,
    pub ground: Ground,
    pub why: String,
    pub standing: Standing,
}

impl Dismissed {
    /// One plain line for the evidence and the next checker's prompt.
    pub fn line(&self) -> String {
        let how = match &self.standing {
            Standing::Dismissed => "dismissed".to_string(),
            Standing::Stands { proof } => format!("dismissed, but it stands: {proof}"),
            Standing::NotRechecked => "dismissed, but nothing re-checked it, so it stands".into(),
        };
        format!(
            "Finding {} ({how}): {} [{}] {}",
            self.number,
            self.finding,
            self.ground.word(),
            self.why
        )
    }
}

/// A dash that separates the ground from the reason: a hyphen with spaces, or an en or em dash. A ground's own hyphens
/// (`no-basis`) have no spaces round them, so they never match.
fn split_ground(rest: &str) -> Option<(&str, &str)> {
    rest.char_indices().find_map(|(index, ch)| {
        let end = index + ch.len_utf8();
        let spaced_hyphen = ch == '-'
            && rest[..index].ends_with(char::is_whitespace)
            && rest[end..].starts_with(char::is_whitespace);
        (spaced_hyphen || matches!(ch, '\u{2013}' | '\u{2014}'))
            .then(|| (&rest[..index], &rest[end..]))
    })
}

/// The dismissals a report makes: one per line shaped `Dismiss <n>: <ground> - <why>`, a list marker or quote mark in
/// front allowed. A line with an unknown or missing ground, a missing reason, a number that isn't one or a repeat of an
/// earlier number is ignored. Windows line ends read as lines.
pub fn parse(report: &str) -> Vec<Dismissal> {
    let mut out: Vec<Dismissal> = Vec::new();
    for line in report.lines() {
        let line = line
            .trim()
            .trim_start_matches(['-', '*', '>', '+', ' ', '\t'])
            .trim();
        let Some(rest) = line
            .get(..7)
            .filter(|head| head.eq_ignore_ascii_case("dismiss"))
        else {
            continue;
        };
        let rest = &line[rest.len()..];
        // `Dismiss 3:` and `Dismiss #3:`; `Dismissed` and `Dismissal` are other words.
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((number, after)) = rest.trim().trim_start_matches('#').split_once(':') else {
            continue;
        };
        let Some(number) = number
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=NUMBER_MAX).contains(n))
        else {
            continue;
        };
        let Some((ground, why)) = split_ground(after) else {
            continue;
        };
        let Some(ground) = Ground::parse(ground) else {
            continue;
        };
        let why: String = why.split_whitespace().collect::<Vec<_>>().join(" ");
        let why: String = why.chars().take(WHY_MAX).collect();
        if why.is_empty() || out.iter().any(|seen| seen.number == number) {
            continue;
        }
        out.push(Dismissal {
            number,
            ground,
            why,
        });
        if out.len() == MAX_DISMISSALS {
            break;
        }
    }
    out
}

/// The dismissals matched to the findings of the round they answer: `problems` is that round's numbered list, first
/// finding 1. A number the round never had is ignored. Every match starts as `NotRechecked`; a running checker settles it.
pub fn matched(dismissals: &[Dismissal], problems: &[String]) -> Vec<Dismissed> {
    dismissals
        .iter()
        .filter_map(|dismissal| {
            let finding = problems.get(dismissal.number.checked_sub(1)?)?;
            Some(Dismissed {
                number: dismissal.number,
                finding: finding.clone(),
                ground: dismissal.ground,
                why: dismissal.why.clone(),
                standing: Standing::NotRechecked,
            })
        })
        .collect()
}

/// The numbered list of a round's findings, with how to dismiss one. Empty when there are none. This is what the worker
/// reads on a fix round, so a number in a dismissal means the same finding to both.
pub fn numbered(problems: &[String]) -> String {
    if problems.is_empty() {
        return String::new();
    }
    let list: Vec<String> = problems
        .iter()
        .enumerate()
        .map(|(index, problem)| format!("{}. {problem}", index + 1))
        .collect();
    let grounds: Vec<&str> = Ground::ALL.iter().map(|ground| ground.word()).collect();
    format!(
        "Findings, numbered:\n{}\nIf a finding is wrong, add a line to your next report: `Dismiss <number>: <ground> - <one line why>`. \
         The ground is one of {}. Any other ground is ignored and the finding stands. A checker may check a dismissed finding again with a command.",
        list.join("\n"),
        grounds.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(report: &str) -> Vec<(usize, Ground, String)> {
        parse(report)
            .into_iter()
            .map(|d| (d.number, d.ground, d.why))
            .collect()
    }

    #[test]
    fn each_of_the_five_grounds_is_read() {
        let report = "Dismiss 1: no-basis - nothing in the diff does that\n\
                      Dismiss 2: misquoted - the brief says 30 days, not 3\n\
                      Dismiss 3: outside-brief - the brief never asked for retries\n\
                      Dismiss 4: not-reproduced - the command passes here\n\
                      Dismiss 5: contradicts-brief - the brief says to keep that call";
        let got = parse(report);
        assert_eq!(
            got.iter().map(|d| (d.number, d.ground)).collect::<Vec<_>>(),
            vec![
                (1, Ground::NoBasis),
                (2, Ground::Misquoted),
                (3, Ground::OutsideBrief),
                (4, Ground::NotReproduced),
                (5, Ground::ContradictsBrief),
            ]
        );
        assert_eq!(got[1].why, "the brief says 30 days, not 3");
        // The words the worker is told are the words the parser reads.
        for ground in Ground::ALL {
            assert_eq!(Ground::parse(ground.word()), Some(ground));
        }
    }

    #[test]
    fn an_unknown_ground_or_none_is_ignored_and_the_finding_stands() {
        for report in [
            "Dismiss 1: because - I disagree",
            "Dismiss 1: wrong - not my change",
            "Dismiss 1: - no ground at all",
            "Dismiss 1:  - ",
            "Dismiss 1: no basis - spaces make it another word",
            "Dismiss 1: no_basis - nor does an underscore",
            "Dismiss 1: no-basisx - nor a longer word",
            "Dismiss 1 no-basis - no colon",
            "Dismiss: no-basis - no number",
            "Dismiss 1: no-basis",
            "Dismiss 1: no-basis - ",
        ] {
            assert!(parse(report).is_empty(), "{report:?} must be ignored");
        }
    }

    #[test]
    fn a_ground_is_not_confused_with_its_own_hyphens_and_the_reason_keeps_its_dashes() {
        let got = one("Dismiss 2: not-reproduced - the build is up-to-date - I ran it twice");
        assert_eq!(
            got,
            vec![(
                2,
                Ground::NotReproduced,
                "the build is up-to-date - I ran it twice".to_string()
            )]
        );
        // An en dash or an em dash separates too; they are what a model types for a hyphen.
        assert_eq!(one("Dismiss 3: misquoted \u{2014} it says 30")[0].0, 3);
        assert_eq!(one("Dismiss 3: misquoted \u{2013} it says 30")[0].0, 3);
    }

    #[test]
    fn case_markers_crlf_and_unicode_are_read_and_other_words_are_not() {
        let report = "Summary: done.\r\n- DISMISS #2: No-Basis - r\u{e9}sum\u{e9} is spelled that way\r\n> dismiss 3: MISQUOTED - it says \u{201c}30\u{201d}\r\nDismissed 4: no-basis - a different word\r\nDismissal 5: no-basis - another\r\n";
        let got = one(report);
        assert_eq!(
            got,
            vec![
                (
                    2,
                    Ground::NoBasis,
                    "r\u{e9}sum\u{e9} is spelled that way".to_string()
                ),
                (
                    3,
                    Ground::Misquoted,
                    "it says \u{201c}30\u{201d}".to_string()
                ),
            ]
        );
    }

    #[test]
    fn numbers_that_are_not_numbers_are_ignored_and_a_repeat_keeps_the_first() {
        assert!(parse("Dismiss 0: no-basis - zero").is_empty());
        assert!(parse("Dismiss -1: no-basis - negative").is_empty());
        assert!(parse("Dismiss one: no-basis - a word").is_empty());
        assert!(parse("Dismiss 1000: no-basis - too big").is_empty());
        assert!(parse("Dismiss 99999999999999999999: no-basis - overflow").is_empty());
        let got = one("Dismiss 2: no-basis - first\nDismiss 2: misquoted - second");
        assert_eq!(got, vec![(2, Ground::NoBasis, "first".to_string())]);
    }

    #[test]
    fn the_reason_is_one_cut_line_and_the_number_of_dismissals_is_bounded() {
        let long = "x".repeat(WHY_MAX + 50);
        let got = parse(&format!("Dismiss 1: no-basis - {long}"));
        assert_eq!(got[0].why.chars().count(), WHY_MAX);
        let many: String = (1..=MAX_DISMISSALS + 5)
            .map(|n| format!("Dismiss {n}: no-basis - why {n}\n"))
            .collect();
        assert_eq!(parse(&many).len(), MAX_DISMISSALS);
        assert!(parse("").is_empty());
        assert!(parse("\n\n   \n").is_empty());
    }

    #[test]
    fn a_dismissal_matches_the_finding_with_that_number_and_nothing_out_of_range() {
        let problems = vec![
            "Weakened test: a.test.ts lost an assert".to_string(),
            "Debris: a.log".to_string(),
        ];
        let dismissals = parse(
            "Dismiss 2: no-basis - a.log is in .gitignore\nDismiss 3: no-basis - there is no third",
        );
        let got = matched(&dismissals, &problems);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].number, 2);
        assert_eq!(got[0].finding, "Debris: a.log");
        // Until a running checker looks, a dismissal changes nothing.
        assert_eq!(got[0].standing, Standing::NotRechecked);
        assert!(matched(&dismissals, &[]).is_empty());
    }

    #[test]
    fn each_standing_reads_in_plain_words_with_the_ground_and_the_reason() {
        let mut dismissed = Dismissed {
            number: 1,
            finding: "Debris: a.log".into(),
            ground: Ground::NoBasis,
            why: "ignored by git".into(),
            standing: Standing::Dismissed,
        };
        assert_eq!(
            dismissed.line(),
            "Finding 1 (dismissed): Debris: a.log [no-basis] ignored by git"
        );
        dismissed.standing = Standing::Stands {
            proof: "git ls-files lists it".into(),
        };
        assert!(dismissed
            .line()
            .contains("it stands: git ls-files lists it"));
        dismissed.standing = Standing::NotRechecked;
        assert!(dismissed
            .line()
            .contains("nothing re-checked it, so it stands"));
    }

    #[test]
    fn the_numbered_list_tells_the_worker_the_form_and_the_five_grounds() {
        assert_eq!(numbered(&[]), "");
        let text = numbered(&["Debris: a.log".into(), "Scope creep: b.ts".into()]);
        assert!(text.contains("1. Debris: a.log\n2. Scope creep: b.ts"));
        assert!(text.contains("Dismiss <number>: <ground> - <one line why>"));
        for ground in Ground::ALL {
            assert!(text.contains(ground.word()), "{}", ground.word());
        }
        assert!(text.contains("ignored and the finding stands"));
    }
}
