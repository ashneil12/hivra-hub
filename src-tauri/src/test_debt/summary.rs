//! PT-5: what the crew tab's one line reads (`test_debt_summary`): how many tests wait to be sorted at ship, whether the fixer is on
//! it, and each test with its file, since when and which task it came from. Pure: the caller says whether the fixer is working.

use serde::Serialize;

use super::doc::Doc;

/// The most tests listed (the webview reads at most this many too).
pub const ITEMS_MAX: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// A short stand-in for the test's id, for the webview to tell tests apart.
    pub id: String,
    pub test: String,
    pub file: String,
    /// Epoch ms: when it was first seen failing (a quarantined test: when it was quarantined).
    pub since: u64,
    /// The task that was running when it first failed.
    pub task: String,
    /// `to-sort`, `real-bug` (waits on the person), `shipping-anyway` (a real bug they chose to ship with) or `flaky`.
    pub state: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Tests still to sort: the ones with no named decision yet. A real bug or a quarantined test is not counted.
    pub count: usize,
    /// The test fixer is working on them.
    pub sorting: bool,
    pub items: Vec<Item>,
}

/// A short id for a test id: 16 hex characters.
pub fn short_id(id: &str) -> String {
    crate::project_file::hash(id.as_bytes())[..16].to_string()
}

/// The list as one line and a popover. A project with nothing waiting has `count` 0 and the webview shows nothing.
pub fn summarize(doc: &Doc, sorting: bool, now: u64) -> Summary {
    let mut items: Vec<Item> = Vec::new();
    let mut waiting: Vec<&super::doc::Item> = doc.undecided().collect();
    waiting.sort_by(|a, b| {
        a.first_seen_at
            .cmp(&b.first_seen_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let count = waiting.len();
    for item in waiting {
        items.push(entry(item, "to-sort"));
    }
    // The real bugs that still wait on the person come first, so a long list never hides them behind the ones they shipped anyway.
    for item in doc.waiting_bugs() {
        items.push(entry(item, "real-bug"));
    }
    for item in doc.real_bugs().filter(|item| item.ship_anyway_at.is_some()) {
        items.push(entry(item, "shipping-anyway"));
    }
    for quarantined in doc.quarantine.iter().filter(|q| now < q.ends_at) {
        items.push(Item {
            id: short_id(&quarantined.id),
            test: quarantined.name.clone(),
            file: quarantined.file.clone(),
            since: quarantined.added_at,
            task: String::new(),
            state: "flaky",
        });
    }
    items.truncate(ITEMS_MAX);
    Summary {
        count,
        sorting,
        items,
    }
}

fn entry(item: &super::doc::Item, state: &'static str) -> Item {
    Item {
        id: short_id(&item.id),
        test: item.name.clone(),
        file: item.file.clone(),
        since: item.first_seen_at,
        task: item.task_title.clone(),
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_debt::doc::Candidate;

    fn cand(name: &str) -> Candidate {
        Candidate {
            runner: "vitest".into(),
            file: "src/a.test.ts".into(),
            name: name.into(),
            failure: "boom".into(),
            task_title: "Add totals".into(),
            ..Candidate::default()
        }
    }

    #[test]
    fn an_empty_list_reads_as_nothing_to_show() {
        let s = summarize(&Doc::default(), false, 1);
        assert_eq!((s.count, s.sorting, s.items.len()), (0, false, 0));
    }

    #[test]
    fn the_count_is_the_tests_still_to_sort_and_a_real_bug_or_flaky_test_is_listed_but_not_counted()
    {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a"), 100);
        doc.note_failure(&cand("b"), 50);
        doc.note_failure(&cand("bug"), 10);
        doc.note_failure(&cand("flaky one"), 20);
        let bug = doc
            .items
            .iter()
            .find(|i| i.name == "bug")
            .unwrap()
            .id
            .clone();
        let flaky = doc
            .items
            .iter()
            .find(|i| i.name == "flaky one")
            .unwrap()
            .id
            .clone();
        doc.mark_code_wrong(&bug, "x", 11);
        doc.mark_flaky(&flaky, "re-run passed", 21);
        let s = summarize(&doc, true, 22);
        assert_eq!(s.count, 2);
        assert!(s.sorting);
        let states: Vec<(&str, &str)> =
            s.items.iter().map(|i| (i.test.as_str(), i.state)).collect();
        assert_eq!(
            states,
            vec![
                ("b", "to-sort"),
                ("a", "to-sort"),
                ("bug", "real-bug"),
                ("flaky one", "flaky")
            ],
            "oldest first, then the named ones"
        );
        assert_eq!(s.items[0].task, "Add totals");
        assert_eq!(s.items[0].since, 50);
        assert_eq!(s.items[0].file, "src/a.test.ts");
    }

    #[test]
    fn a_real_bug_the_person_shipped_anyway_is_listed_apart_from_the_ones_still_waiting_on_them() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("bug one"), 10);
        doc.note_failure(&cand("bug two"), 20);
        doc.note_failure(&cand("sort me"), 30);
        let (one, two) = (doc.items[0].id.clone(), doc.items[1].id.clone());
        doc.mark_code_wrong(&one, "x", 11);
        doc.mark_code_wrong(&two, "y", 21);
        let key = Doc::bug_key(&doc.items[0]);
        assert!(doc.ship_bug_anyway(&key, 40));
        let s = summarize(&doc, false, 50);
        assert_eq!(s.count, 1, "a real bug is never counted as one to sort");
        let states: Vec<(&str, &str)> =
            s.items.iter().map(|i| (i.test.as_str(), i.state)).collect();
        assert_eq!(
            states,
            vec![
                ("sort me", "to-sort"),
                ("bug two", "real-bug"),
                ("bug one", "shipping-anyway")
            ],
            "the ones that still wait come first, so a long list never hides them"
        );
    }

    #[test]
    fn an_expired_quarantine_is_not_listed_as_flaky() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("f"), 1);
        let id = doc.items[0].id.clone();
        doc.mark_flaky(&id, "x", 10);
        let end = doc.quarantine[0].ends_at;
        assert_eq!(summarize(&doc, false, end - 1).items.len(), 1);
        assert_eq!(summarize(&doc, false, end).items.len(), 0);
    }

    #[test]
    fn at_most_a_hundred_items_are_listed_and_ids_are_short_and_distinct() {
        let mut doc = Doc::default();
        for n in 0..150 {
            doc.note_failure(&cand(&format!("t{n}")), n);
        }
        let s = summarize(&doc, false, 1_000);
        assert_eq!(s.count, 150);
        assert_eq!(s.items.len(), ITEMS_MAX);
        assert!(s.items.iter().all(|i| i.id.len() == 16));
        let distinct: std::collections::HashSet<&String> = s.items.iter().map(|i| &i.id).collect();
        assert_eq!(distinct.len(), ITEMS_MAX);
    }

    #[test]
    fn the_answer_has_the_names_the_webview_reads() {
        let mut doc = Doc::default();
        doc.note_failure(&cand("a"), 5);
        let value = serde_json::to_value(summarize(&doc, false, 6)).unwrap();
        assert_eq!(value["count"], 1);
        assert_eq!(value["sorting"], false);
        assert_eq!(value["items"][0]["state"], "to-sort");
        assert!(value["items"][0]["since"].is_u64());
    }
}
