// Translated from Orbit (Apache-2.0), apps/server/src/integration_routes.rs (`github_webhook`) and
// apps/server/src/repositories/tasks.rs (`sync_github_work_item`, `GithubWorkItem`).
//
// Hivra has no sqlx and no public URL, so these decisions run on a poll. The upstream files do not
// carry a separate copyright line. See the root NOTICE.
//
// Two rewrites, both forced by Hivra's store: a title over 300 characters or a description over
// 12_000 is rejected, not stored (Orbit allows 500 and 100_000). A poll has no webhook action, so
// `state_changed` is true only when the stored GitHub state differs (Orbit sets it for `closed`
// and `reopened` only).

use crate::instance::Kind;
use crate::tasks::store::{TEXT_MAX, TITLE_MAX};

/// At most one read every few minutes. An unchanged board waits longer, up to half an hour.
pub const MIN_POLL_MS: i64 = 3 * 60 * 1000;
pub const MAX_POLL_MS: i64 = 30 * 60 * 1000;

/// How long to wait after `idle_streak` polls that changed nothing. Streak 0 is the minimum gap.
pub fn gap_after(idle_streak: i64) -> i64 {
    let steps = idle_streak.clamp(0, 8);
    let mut gap = MIN_POLL_MS;
    for _ in 0..steps {
        gap = gap.saturating_mul(2).min(MAX_POLL_MS);
    }
    gap
}

/// Orbit's status category for a work item. Anything else stays unstarted.
pub fn status_category(kind: &str, state: &str) -> &'static str {
    match (kind, state) {
        ("pull_request", "merged") | ("issue", "closed") => "completed",
        ("pull_request", "closed") => "cancelled",
        _ => "unstarted",
    }
}

/// The workflow row Hivra seeds for that category. Unstarted is Backlog, the first one, not Todo.
pub fn status_name(category: &str) -> &'static str {
    match category {
        "completed" => "Done",
        "cancelled" => "Cancelled",
        _ => "Backlog",
    }
}

/// A poll has no `action`. The stored state differing is the closed/reopened case; an edit is not.
pub fn state_changed(stored: Option<&str>, state: &str) -> bool {
    stored != Some(state)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    EmptyTitle,
    TitleTooLong,
    DescriptionTooLong,
}

/// Orbit trims the title and refuses an empty or over-long title or body. Hivra's caps are lower,
/// and the item is skipped rather than truncated.
pub fn accept_text(title: &str, description: &str) -> Result<(String, String), Reject> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Reject::EmptyTitle);
    }
    if title.chars().count() > TITLE_MAX {
        return Err(Reject::TitleTooLong);
    }
    if description.chars().count() > TEXT_MAX {
        return Err(Reject::DescriptionTooLong);
    }
    Ok((title.to_string(), description.to_string()))
}

/// `owner/name`, nothing else. `..`, a space, or a third segment is refused.
pub fn repo_ok(value: &str) -> Result<String, String> {
    let value = value.trim();
    let Some((owner, name)) = value.split_once('/') else {
        return Err("The repo should look like owner/name.".into());
    };
    let part = |piece: &str| {
        !piece.is_empty()
            && piece != "."
            && piece != ".."
            && piece
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !part(owner) || !part(name) || value.split('/').count() != 2 {
        return Err("The repo should look like owner/name.".into());
    }
    Ok(value.to_string())
}

/// A GitHub label, minus characters that would change the search. Spaces and unicode stay.
pub fn label_ok(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("The label is empty.".into());
    }
    if value.chars().count() > 50 {
        return Err("The label is too long.".into());
    }
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '\\'))
    {
        return Err("That label can't be used in a GitHub search.".into());
    }
    Ok(value.to_string())
}

/// Kind and label, as `formatGithubQuery` writes them, then both states.
///
/// `--state all` is a separate flag. A search that does not name a state comes back
/// open only, so a closed issue or a merged pull request would look like the label left.
/// `is:closed` includes a merged pull request.
pub fn search_query(kind: &str, label: &str) -> Result<String, String> {
    let label = label_ok(label)?;
    let is = if kind == "pr" || kind == "pull_request" {
        "is:pr"
    } else {
        "is:issue"
    };
    let term = if label
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        format!("label:{label}")
    } else {
        format!("label:\"{label}\"")
    };
    Ok(format!("{is} {term} (is:open OR is:closed)"))
}

/// Which configured project a labelled item belongs to. Two matches are a conflict: don't move it.
pub fn chosen_project<'a>(matched: &[&'a str]) -> Choice<&'a str> {
    match matched {
        [] => Choice::None,
        [one] => Choice::One(one),
        _ => Choice::Ambiguous,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Choice<T> {
    None,
    One(T),
    Ambiguous,
}

/// Where a `gh` read runs. A dev copy never falls through to a real account. The daily app never
/// reads the stand-in, even when the variable is set.
#[derive(Debug, PartialEq, Eq)]
pub enum GhChoice {
    StandIn(String),
    Installed,
    DevWithoutStandIn,
}

pub fn choose_gh(kind: Kind, stand_in: Option<&str>) -> GhChoice {
    if kind == Kind::Dev {
        return match stand_in.map(str::trim).filter(|path| !path.is_empty()) {
            Some(path) => GhChoice::StandIn(path.to_string()),
            None => GhChoice::DevWithoutStandIn,
        };
    }
    GhChoice::Installed
}

/// A GitHub login: 1–39 ASCII letters, digits or `-`, not starting or ending with `-`.
/// `../`, a slash, or a bot suffix never reaches `gh`.
pub fn login_ok(value: &str) -> bool {
    let value = value.trim();
    let len = value.chars().count();
    (1..=39).contains(&len)
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `admin`, `maintain` and `write` may change the repo. Anything else, including a blank, does not.
pub fn writes(permission: &str) -> bool {
    matches!(
        permission.trim().to_ascii_lowercase().as_str(),
        "admin" | "maintain" | "write"
    )
}

/// The coding team may pick the item up on its own only when the author is the signed-in person
/// or the permission read said they can write. A missing or failed read is not a yes.
pub fn may_auto_brief(person: Option<&str>, author: &str, permission: Option<&str>) -> bool {
    if !login_ok(author) {
        return false;
    }
    if let Some(person) = person.map(str::trim).filter(|login| login_ok(login)) {
        if person.eq_ignore_ascii_case(author.trim()) {
            return true;
        }
    }
    permission.is_some_and(writes)
}

/// `https://github.com/{repo}/issues|pull/{n}`. Orbit uses `pull`, not `pulls`.
pub fn work_url(repo: &str, kind: &str, number: i64) -> Option<String> {
    let repo = repo_ok(repo).ok()?;
    if number <= 0 {
        return None;
    }
    let path = if kind == "pull_request" {
        "pull"
    } else {
        "issues"
    };
    Some(format!("https://github.com/{repo}/{path}/{number}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_follow_orbit() {
        assert_eq!(status_category("issue", "closed"), "completed");
        assert_eq!(status_category("issue", "open"), "unstarted");
        assert_eq!(status_category("pull_request", "merged"), "completed");
        assert_eq!(status_category("pull_request", "closed"), "cancelled");
        assert_eq!(status_category("pull_request", "open"), "unstarted");
        assert_eq!(status_name("completed"), "Done");
        assert_eq!(status_name("cancelled"), "Cancelled");
        assert_eq!(status_name("unstarted"), "Backlog");
    }

    #[test]
    fn an_edit_is_not_a_state_change_and_a_close_is() {
        assert!(!state_changed(Some("open"), "open"));
        assert!(state_changed(Some("open"), "closed"));
        assert!(state_changed(None, "open"));
    }

    #[test]
    fn empty_and_over_long_text_is_refused_not_cut() {
        assert_eq!(accept_text("  ", "body"), Err(Reject::EmptyTitle));
        assert_eq!(accept_text("\r\n", ""), Err(Reject::EmptyTitle));
        let long = "n".repeat(TITLE_MAX + 1);
        assert_eq!(accept_text(&long, ""), Err(Reject::TitleTooLong));
        assert!(accept_text(&"n".repeat(TITLE_MAX), "").is_ok());
        let body = "b".repeat(TEXT_MAX + 1);
        assert_eq!(accept_text("Title", &body), Err(Reject::DescriptionTooLong));
        assert_eq!(accept_text("  Hello\r\n", "a\r\nb").unwrap().0, "Hello");
    }

    #[test]
    fn the_search_names_open_and_closed() {
        // A query that does not name both states is not a full board. Closed issues and
        // merged pull requests have to come back, or the next read treats them as unlabelled.
        let issues = search_query("issue", "hivra").unwrap();
        assert!(
            issues.contains("is:open") && issues.contains("is:closed"),
            "{issues}"
        );
        let prs = search_query("pull_request", "needs hivra").unwrap();
        assert!(
            prs.contains("is:open") && prs.contains("is:closed"),
            "{prs}"
        );
        assert!(prs.contains("label:\"needs hivra\""));
    }

    #[test]
    fn the_search_matches_the_inbox_query_shape() {
        assert_eq!(
            search_query("issue", "hivra").unwrap(),
            "is:issue label:hivra (is:open OR is:closed)"
        );
        assert_eq!(
            search_query("pull_request", "needs hivra").unwrap(),
            "is:pr label:\"needs hivra\" (is:open OR is:closed)"
        );
        assert!(search_query("issue", "bad\"label").is_err());
        assert!(search_query("issue", "a\nb").is_err());
        assert!(label_ok("  café label  ").is_ok());
    }

    #[test]
    fn two_project_labels_are_a_conflict_and_none_is_not_a_move() {
        assert_eq!(chosen_project(&[]), Choice::None);
        assert_eq!(chosen_project(&["a"]), Choice::One("a"));
        assert_eq!(chosen_project(&["a", "b"]), Choice::Ambiguous);
    }

    #[test]
    fn the_repo_is_owner_and_name_only() {
        assert!(repo_ok("acme/web").is_ok());
        assert!(repo_ok("acme/web.old").is_ok());
        assert!(repo_ok("../web").is_err());
        assert!(repo_ok("acme/../web").is_err());
        assert!(repo_ok("acme/web/extra").is_err());
        assert!(repo_ok("acme /web").is_err());
        assert!(repo_ok("").is_err());
        assert!(work_url("acme/web", "issue", 4)
            .unwrap()
            .ends_with("/issues/4"));
        assert!(work_url("acme/web", "pull_request", 4)
            .unwrap()
            .ends_with("/pull/4"));
        assert!(work_url("not a repo", "issue", 1).is_none());
    }

    #[test]
    fn a_dev_copy_never_uses_a_real_account_and_the_daily_app_ignores_the_stand_in() {
        assert_eq!(
            choose_gh(Kind::Daily, Some("/tmp/fake gh")),
            GhChoice::Installed
        );
        assert_eq!(choose_gh(Kind::Daily, None), GhChoice::Installed);
        assert_eq!(
            choose_gh(Kind::Dev, Some("  /tmp/fake gh  ")),
            GhChoice::StandIn("/tmp/fake gh".into())
        );
        assert_eq!(
            choose_gh(Kind::Dev, Some("  ")),
            GhChoice::DevWithoutStandIn
        );
        assert_eq!(choose_gh(Kind::Dev, None), GhChoice::DevWithoutStandIn);
    }

    #[test]
    fn a_login_is_a_github_name_and_nothing_that_could_change_the_path() {
        assert!(login_ok("ash"));
        assert!(login_ok("Ada-9"));
        assert!(login_ok(&"a".repeat(39)));
        assert!(!login_ok(&"a".repeat(40)));
        assert!(!login_ok(""));
        assert!(!login_ok("-ash"));
        assert!(!login_ok("ash-"));
        assert!(!login_ok("../ada"));
        assert!(!login_ok("app/dependabot"));
        assert!(!login_ok("dependabot[bot]"));
        assert!(!login_ok("a b"));
        assert!(!login_ok("café"));
    }

    #[test]
    fn only_write_access_or_the_person_may_auto_brief() {
        assert!(writes("admin"));
        assert!(writes("maintain"));
        assert!(writes("WRITE"));
        assert!(!writes("read"));
        assert!(!writes("triage"));
        assert!(!writes("none"));
        assert!(!writes(""));
        assert!(may_auto_brief(Some("Ash"), "ash", None));
        assert!(may_auto_brief(Some("ash"), "ada", Some("write")));
        assert!(may_auto_brief(None, "ada", Some("admin")));
        assert!(!may_auto_brief(Some("ash"), "ada", Some("read")));
        assert!(!may_auto_brief(Some("ash"), "ada", Some("triage")));
        assert!(!may_auto_brief(Some("ash"), "ada", None));
        assert!(!may_auto_brief(None, "ada", None));
        assert!(!may_auto_brief(Some("ash"), "../ada", Some("admin")));
        assert!(!may_auto_brief(Some("not a login"), "not a login", None));
    }

    #[test]
    fn backoff_doubles_until_half_an_hour() {
        assert_eq!(gap_after(0), MIN_POLL_MS);
        assert_eq!(gap_after(1), MIN_POLL_MS * 2);
        assert_eq!(gap_after(2), MIN_POLL_MS * 4);
        assert_eq!(gap_after(4), MAX_POLL_MS);
        assert_eq!(gap_after(8), MAX_POLL_MS);
    }
}
