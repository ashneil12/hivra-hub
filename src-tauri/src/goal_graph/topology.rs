// Copyright (c) 2026 oh-my-hermes contributors
// SPDX-License-Identifier: MIT
// Source: https://github.com/rlaope/oh-my-hermes src/plugin_bundle/omh/dag_core.py at 2676c33
//
// WP-91: dag_core.py translated line by line to Rust. The dependency checks, the layers, the critical path, the
// bottlenecks and the shared write scopes are the original's, edge cases included, so the two can be read side by
// side. What changed: Python's `None` return for an unplaceable graph is `Option`, a returned dict is a `BTreeMap`
// (a Rust map has no insertion order, and every caller sorts before it reads), and `fnmatch.fnmatchcase` is the
// matcher at the bottom of this file.

//! The one DAG core: dependency checks, layers, critical path and bottlenecks for every graph Hivra keeps.
//!
//! An orchestration run's goal graph decides its topology here. Each caller keeps its own error type and wording.
//! A graph is a sequence of node ids and, per node, the ids it depends on (its parents). A parent that is not one
//! of the ids is ignored by the topology functions (`layer_of` can instead hold what waits on it), so a caller
//! checks its references first (`edge_problem`). A layer is a node's longest path from a node with no parent; it
//! orders, it never gates.

use std::collections::{BTreeMap, BTreeSet};

/// A parent named in `parents` that is not one of the graph's ids.
pub const UNKNOWN_DEPENDENCY: &str = "unknown_dependency";
/// A node that lists itself as its own parent.
pub const SELF_DEPENDENCY: &str = "self_dependency";
/// How many nodes `bottlenecks` names when the caller asks for no limit.
pub const BOTTLENECK_LIMIT: usize = 3;

/// The first wrong reference in a node's parents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EdgeProblem {
    /// (`UNKNOWN_DEPENDENCY`, the parent).
    UnknownDependency(String),
    /// (`SELF_DEPENDENCY`, the parent).
    SelfDependency(String),
}

impl EdgeProblem {
    pub fn reason(&self) -> &'static str {
        match self {
            EdgeProblem::UnknownDependency(_) => UNKNOWN_DEPENDENCY,
            EdgeProblem::SelfDependency(_) => SELF_DEPENDENCY,
        }
    }

    pub fn parent(&self) -> &str {
        match self {
            EdgeProblem::UnknownDependency(parent) | EdgeProblem::SelfDependency(parent) => parent,
        }
    }
}

/// The ids in first-seen order, each once.
pub fn unique(ids: &[String]) -> Vec<String> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut ordered: Vec<String> = Vec::new();
    for node in ids {
        if seen.insert(node.as_str()) {
            ordered.push(node.clone());
        }
    }
    ordered
}

/// The first wrong reference in `parents`: (`UNKNOWN_DEPENDENCY` | `SELF_DEPENDENCY`, the parent), or `None`.
pub fn edge_problem(
    node: &str,
    parents: &[String],
    known: &BTreeSet<String>,
) -> Option<EdgeProblem> {
    for parent in parents {
        if !known.contains(parent) {
            return Some(EdgeProblem::UnknownDependency(parent.clone()));
        }
        if parent == node {
            return Some(EdgeProblem::SelfDependency(parent.clone()));
        }
    }
    None
}

/// A graph: the node ids in order, and each node's parents.
pub type Parents = BTreeMap<String, Vec<String>>;

/// Each placed node's layer, and the nodes left unplaced (on a cycle or below one), in `ids` order.
///
/// A node is placed in the round after the last of its parents was, so its layer is its longest path from a node
/// with no parent. A self edge is a cycle. A parent outside `ids` is ignored, unless `strict`: then it is never
/// placed, and neither is anything that waits on it.
pub fn layer_of(
    ids: &[String],
    parents: &Parents,
    strict: bool,
) -> (BTreeMap<String, usize>, Vec<String>) {
    let order = unique(ids);
    let known: BTreeSet<String> = order.iter().cloned().collect();
    let edges: Parents = order
        .iter()
        .map(|node| {
            let listed = parents.get(node).cloned().unwrap_or_default();
            let kept: Vec<String> = listed
                .into_iter()
                .filter(|parent| strict || known.contains(parent))
                .collect();
            (node.clone(), kept)
        })
        .collect();
    let mut placed: BTreeMap<String, usize> = BTreeMap::new();
    let mut remaining = order.clone();
    let mut depth = 0usize;
    while !remaining.is_empty() {
        let ready: Vec<String> = remaining
            .iter()
            .filter(|node| {
                edges
                    .get(*node)
                    .map(|listed| listed.iter().all(|parent| placed.contains_key(parent)))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            break;
        }
        for node in &ready {
            placed.insert(node.clone(), depth);
        }
        remaining.retain(|node| !placed.contains_key(node));
        depth += 1;
    }
    (placed, remaining)
}

/// The nodes by layer, in `ids` order within each; `None` when the graph holds a cycle.
pub fn layers(ids: &[String], parents: &Parents) -> Option<Vec<Vec<String>>> {
    let (placed, stuck) = layer_of(ids, parents, false);
    if !stuck.is_empty() {
        return None;
    }
    let order = unique(ids);
    let depth = placed
        .values()
        .copied()
        .max()
        .map(|top| top + 1)
        .unwrap_or(0);
    Some(
        (0..depth)
            .map(|index| {
                order
                    .iter()
                    .filter(|node| placed.get(*node) == Some(&index))
                    .cloned()
                    .collect()
            })
            .collect(),
    )
}

/// The candidates every one of whose parents is satisfied, in candidate order.
pub fn ready(
    candidates: &[String],
    parents: &Parents,
    satisfied: &BTreeSet<String>,
) -> Vec<String> {
    unique(candidates)
        .into_iter()
        .filter(|node| {
            parents
                .get(node)
                .map(|listed| listed.iter().all(|parent| satisfied.contains(parent)))
                .unwrap_or(true)
        })
        .collect()
}

/// The longest chain of nodes, first to last; ties go to the smaller id. Empty for a cyclic or empty graph.
pub fn critical_path(ids: &[String], parents: &Parents) -> Vec<String> {
    let (placed, stuck) = layer_of(ids, parents, false);
    if !stuck.is_empty() || placed.is_empty() {
        return Vec::new();
    }
    let known: BTreeSet<String> = placed.keys().cloned().collect();
    let mut ordered: Vec<String> = placed.keys().cloned().collect();
    ordered.sort_by_key(|node| (placed[node], node.clone()));
    let mut length: BTreeMap<String, usize> = BTreeMap::new();
    let mut previous: BTreeMap<String, String> = BTreeMap::new();
    for node in &ordered {
        let mut listed: Vec<String> = parents
            .get(node)
            .map(|value| {
                value
                    .iter()
                    .filter(|parent| known.contains(*parent))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        listed.sort();
        listed.dedup();
        let mut best = String::new();
        for parent in listed {
            if best.is_empty() || length[&parent] > length[&best] {
                best = parent;
            }
        }
        let base = if best.is_empty() { 0 } else { length[&best] };
        length.insert(node.clone(), 1 + base);
        if !best.is_empty() {
            previous.insert(node.clone(), best);
        }
    }
    // The last node of the longest chain, ties to the smaller id.
    let mut end = ordered.first().cloned().unwrap_or_default();
    for node in &ordered {
        if length[node] > length[&end] || (length[node] == length[&end] && node < &end) {
            end = node.clone();
        }
    }
    let mut path = vec![end.clone()];
    while let Some(step) = previous.get(path.last().unwrap()) {
        path.push(step.clone());
    }
    path.reverse();
    path
}

/// The nodes the most others wait on, directly or not, as (id, how many); only nodes something waits on.
pub fn bottlenecks(ids: &[String], parents: &Parents, limit: usize) -> Vec<(String, usize)> {
    let order = unique(ids);
    let known: BTreeSet<String> = order.iter().cloned().collect();
    let mut children: BTreeMap<String, BTreeSet<String>> = order
        .iter()
        .map(|node| (node.clone(), BTreeSet::new()))
        .collect();
    for node in &order {
        for parent in parents.get(node).map(Vec::as_slice).unwrap_or(&[]) {
            if known.contains(parent) && parent != node {
                children
                    .entry(parent.clone())
                    .or_default()
                    .insert(node.clone());
            }
        }
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for node in &order {
        let mut below: BTreeSet<String> = BTreeSet::new();
        let mut frontier: Vec<String> = children
            .get(node)
            .map(|set| set.iter().cloned().collect::<Vec<String>>())
            .unwrap_or_default();
        while let Some(current) = frontier.pop() {
            if current != *node && below.insert(current.clone()) {
                frontier.extend(
                    children
                        .get(&current)
                        .map(|set| set.iter().cloned().collect::<Vec<String>>())
                        .unwrap_or_default(),
                );
            }
        }
        if !below.is_empty() {
            counts.push((node.clone(), below.len()));
        }
    }
    counts.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    counts.truncate(limit);
    counts
}

// ---- write scopes ---------------------------------------------------------------------------------------------------

/// A write-scope entry for [`shared_scope_pairs`] `as_paths`: the segments it writes under, its glob, its file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopePath {
    /// The directory segments it writes under; a leading `"/"` segment means the entry was absolute.
    pub under: Vec<String>,
    /// The whole pattern when the entry holds a glob, `[]`-escaped; empty otherwise.
    pub glob: String,
    /// The normalised path when the entry is neither a glob nor written as a directory, and its last segment has a
    /// suffix; empty otherwise.
    pub file: String,
}

/// `\\` reads as `/`, case is folded and the rest goes through `posixpath.normpath`, so `./`, a repeated or
/// trailing `/` and `x/..` change nothing; a leading `/` stays a first `/` segment. Surrounding whitespace and a
/// stray `\r` (a CRLF list read from a file) are dropped first, so `" src/a.rs\r"` is `src/a.rs`. A `*` or `?` glob
/// writes under the directory before the segment holding it, and keeps its whole pattern, with `**/` read as `*`
/// (`*` already crosses `/`) and `[` escaped (a path like `app/[slug]/page.tsx` names a file far more often than a
/// write scope holds a character class).
pub fn scope_path(entry: &str) -> ScopePath {
    let text = entry.trim().replace('\\', "/").to_lowercase();
    let absolute = text.starts_with('/');
    let stripped = text.trim_start_matches('/');
    let normal = posix_normpath(if stripped.is_empty() { "." } else { stripped });
    let segments: Vec<String> = if normal == "." {
        Vec::new()
    } else {
        normal.split('/').map(str::to_string).collect()
    };
    let globbed: Option<usize> = segments
        .iter()
        .position(|segment| segment.contains('*') || segment.contains('?'));
    let mut under: Vec<String> = Vec::new();
    if absolute {
        under.push("/".to_string());
    }
    under.extend(match globbed {
        Some(index) => segments[..index].to_vec(),
        None => segments.clone(),
    });
    let whole = format!("{}{}", if absolute { "/" } else { "" }, segments.join("/"));
    let glob = if globbed.is_some() {
        whole.replace("**/", "*").replace('[', "[[]")
    } else {
        String::new()
    };
    let concrete = globbed.is_none()
        && !text.ends_with('/')
        && !segments.is_empty()
        && !splitext(&segments[segments.len() - 1]).1.is_empty();
    ScopePath {
        under,
        glob,
        file: if concrete { whole } else { String::new() },
    }
}

/// `posixpath.normpath`.
fn posix_normpath(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let initial_slashes = if path.starts_with("//") && !path.starts_with("///") {
        2
    } else if path.starts_with('/') {
        1
    } else {
        0
    };
    let mut parts: Vec<&str> = Vec::new();
    for component in path.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component != ".."
            || (initial_slashes == 0 && parts.is_empty())
            || parts.last() == Some(&"..")
        {
            parts.push(component);
        } else if !parts.is_empty() {
            parts.pop();
        }
    }
    let joined = parts.join("/");
    let with_root = if initial_slashes > 0 {
        format!("{}{}", "/".repeat(initial_slashes), joined)
    } else {
        joined
    };
    if with_root.is_empty() {
        ".".to_string()
    } else {
        with_root
    }
}

/// `posixpath.splitext`: a leading dot is not a suffix.
fn splitext(segment: &str) -> (String, String) {
    let chars: Vec<char> = segment.chars().collect();
    let mut index = chars.len();
    while index > 0 {
        index -= 1;
        if chars[index] == '.' {
            if index == 0 {
                return (segment.to_string(), String::new());
            }
            return (
                chars[..index].iter().collect(),
                chars[index..].iter().collect(),
            );
        }
    }
    (segment.to_string(), String::new())
}

/// Whether two [`scope_path`] entries may write one path: one writes under the other, and a glob beside a file
/// matches it (`*` crosses `/`). A glob beside a glob or a directory meets by its directory alone.
fn meets(first: &ScopePath, second: &ScopePath) -> bool {
    let under_meets = |a: &[String], b: &[String]| a.len() <= b.len() && b[..a.len()] == a[..];
    if !under_meets(&first.under, &second.under) && !under_meets(&second.under, &first.under) {
        return false;
    }
    if !first.glob.is_empty() && !second.file.is_empty() {
        return fnmatch_case(&first.glob, &second.file);
    }
    if !second.glob.is_empty() && !first.file.is_empty() {
        return fnmatch_case(&second.glob, &first.file);
    }
    true
}

/// One pair of nodes whose scopes name a same entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopePair {
    pub first: String,
    pub second: String,
    /// Every entry of either node that meets one of the other's, as written.
    pub shared: Vec<String>,
    /// One of the two lists the other as a parent directly; an order through a third node does not count.
    pub joined: bool,
}

/// Every pair of nodes whose scopes name a same entry: (first, second, the shared entries, joined by an edge).
///
/// Entries are compared as written, unless `as_paths`: then two entries meet as [`meets`] says (`src` and
/// `src/x.py` meet, `src/a` and `src/ab` do not, `*.md` meets `docs/a.md` and not `src/x.py`), and the shared
/// entries are every entry of either node that meets one of the other's, as written.
pub fn shared_scope_pairs(
    scopes: &[(String, Vec<String>)],
    parents: &Parents,
    as_paths: bool,
) -> Vec<ScopePair> {
    let edges: BTreeSet<(String, String)> = parents
        .iter()
        .flat_map(|(node, listed)| {
            listed
                .iter()
                .map(move |parent| (node.clone(), parent.clone()))
        })
        .collect();
    let indexed: Vec<(&String, Vec<(&String, ScopePath)>)> = scopes
        .iter()
        .map(|(node, scope)| {
            let entries = scope
                .iter()
                .map(|entry| {
                    (
                        entry,
                        if as_paths {
                            scope_path(entry)
                        } else {
                            ScopePath {
                                under: vec![entry.clone()],
                                glob: String::new(),
                                file: String::new(),
                            }
                        },
                    )
                })
                .collect();
            (node, entries)
        })
        .collect();
    let mut pairs: Vec<ScopePair> = Vec::new();
    for (position, (first, first_scope)) in indexed.iter().enumerate() {
        for (second, second_scope) in indexed[position + 1..].iter() {
            let mut shared: BTreeSet<String> = BTreeSet::new();
            for (first_entry, first_path) in first_scope {
                for (second_entry, second_path) in second_scope {
                    if meets(first_path, second_path) {
                        shared.insert((*first_entry).clone());
                        shared.insert((*second_entry).clone());
                    }
                }
            }
            if !shared.is_empty() {
                pairs.push(ScopePair {
                    first: (*first).clone(),
                    second: (*second).clone(),
                    shared: shared.into_iter().collect(),
                    joined: edges.contains(&((*first).clone(), (*second).clone()))
                        || edges.contains(&((*second).clone(), (*first).clone())),
                });
            }
        }
    }
    pairs
}

/// `fnmatch.fnmatchcase`: `*` crosses `/`, `?` is one character, `[`…`]` is a class (`!` negates). The source
/// escapes every `[` before it matches, so a bracket expression here only ever spells a literal `[`.
pub fn fnmatch_case(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    fn go(pattern: &[char], name: &[char]) -> bool {
        match pattern.first() {
            None => name.is_empty(),
            Some('*') => (0..=name.len()).any(|skip| go(&pattern[1..], &name[skip..])),
            Some('?') => !name.is_empty() && go(&pattern[1..], &name[1..]),
            Some('[') => {
                let Some((class, rest)) = char_class(&pattern[1..]) else {
                    return name.first() == Some(&'[') && go(&pattern[1..], &name[1..]);
                };
                !name.is_empty() && class(name[0]) && go(rest, &name[1..])
            }
            Some(c) => name.first() == Some(c) && go(&pattern[1..], &name[1..]),
        }
    }
    go(&pattern, &name)
}

/// A character class's test, and the pattern that follows its `]`.
type CharClass<'a> = (Box<dyn Fn(char) -> bool>, &'a [char]);

/// The class inside `[...]`, and the pattern after its `]`. Translation: an unmatched `[` is literal.
fn char_class(pattern: &[char]) -> Option<CharClass<'_>> {
    let mut index = if pattern.first() == Some(&'!') { 1 } else { 0 };
    if pattern.get(index) == Some(&']') {
        index += 1;
    }
    while index < pattern.len() && pattern[index] != ']' {
        index += 1;
    }
    if index >= pattern.len() {
        return None;
    }
    let negated = pattern.first() == Some(&'!');
    let stuff: Vec<char> = pattern[if negated { 1 } else { 0 }..index].to_vec();
    let rest = &pattern[index + 1..];
    if stuff.is_empty() {
        return Some((Box::new(|_| false), rest));
    }
    if stuff.len() == 1 && stuff[0] == '!' {
        return Some((Box::new(|_| true), rest));
    }
    let matcher = move |candidate: char| {
        let mut position = 0usize;
        let mut found = false;
        while position < stuff.len() {
            if position + 2 < stuff.len() && stuff[position + 1] == '-' {
                if stuff[position] <= candidate && candidate <= stuff[position + 2] {
                    found = true;
                }
                position += 3;
                continue;
            }
            if stuff[position] == candidate {
                found = true;
            }
            position += 1;
        }
        found
    };
    Some((Box::new(matcher), rest))
}

#[cfg(test)]
mod tests {
    //! Ported from oh-my-hermes `tests/test_dag_core.py` (the `dag_core` cases), at 2676c33.

    use super::*;

    fn parents(pairs: &[(&str, &[&str])]) -> Parents {
        pairs
            .iter()
            .map(|(node, listed)| {
                (
                    (*node).to_string(),
                    listed.iter().map(|value| (*value).to_string()).collect(),
                )
            })
            .collect()
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn diamond() -> Parents {
        parents(&[("a", &[]), ("b", &["a"]), ("c", &["a"]), ("d", &["b", "c"])])
    }

    fn known(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn unknown_comes_before_self_and_order_is_kept() {
        assert_eq!(edge_problem("b", &ids(&["a"]), &known(&["a", "b"])), None);
        assert_eq!(
            edge_problem("b", &ids(&["x", "b"]), &known(&["a", "b"])),
            Some(EdgeProblem::UnknownDependency("x".into()))
        );
        assert_eq!(
            edge_problem("b", &ids(&["b", "x"]), &known(&["a", "b"])),
            Some(EdgeProblem::SelfDependency("b".into()))
        );
    }

    #[test]
    fn layers_are_longest_paths_in_input_order() {
        assert_eq!(
            layers(&ids(&["a", "b", "c", "d"]), &diamond()),
            Some(vec![ids(&["a"]), ids(&["b", "c"]), ids(&["d"])])
        );
        // A repeated id is kept once, where it first appeared.
        assert_eq!(
            layers(&ids(&["a", "b", "a", "c"]), &diamond()),
            Some(vec![ids(&["a"]), ids(&["b", "c"])])
        );
        // A node waiting on a deep chain lands below the deepest parent, not beside the shallow one.
        let chain = parents(&[("a", &[]), ("b", &["a"]), ("c", &["b"]), ("x", &["a", "c"])]);
        assert_eq!(
            layers(&ids(&["a", "b", "c", "x"]), &chain),
            Some(vec![ids(&["a"]), ids(&["b"]), ids(&["c"]), ids(&["x"])])
        );
    }

    #[test]
    fn a_cycle_leaves_its_nodes_and_everything_below_unplaced() {
        let graph = parents(&[("a", &[]), ("b", &["a", "c"]), ("c", &["b"]), ("d", &["c"])]);
        let (placed, stuck) = layer_of(&ids(&["a", "b", "c", "d"]), &graph, false);
        assert_eq!(placed, BTreeMap::from([("a".to_string(), 0)]));
        assert_eq!(stuck, ids(&["b", "c", "d"]));
        assert_eq!(layers(&ids(&["a", "b", "c", "d"]), &graph), None);
    }

    #[test]
    fn a_self_edge_is_a_cycle_and_unknown_parents_are_ignored() {
        assert_eq!(layers(&ids(&["a"]), &parents(&[("a", &["a"])])), None);
        assert_eq!(
            layers(&ids(&["a", "b"]), &parents(&[("b", &["a", "ghost"])])),
            Some(vec![ids(&["a"]), ids(&["b"])])
        );
    }

    #[test]
    fn strict_holds_what_waits_on_an_unknown_parent() {
        let graph = parents(&[("a", &[]), ("b", &["ghost"]), ("c", &["b"])]);
        assert_eq!(
            layer_of(&ids(&["a", "b", "c"]), &graph, true),
            (BTreeMap::from([("a".to_string(), 0)]), ids(&["b", "c"]))
        );
        assert_eq!(
            layer_of(&ids(&["a", "b", "c"]), &graph, false),
            (
                BTreeMap::from([
                    ("a".to_string(), 0),
                    ("b".to_string(), 0),
                    ("c".to_string(), 1)
                ]),
                Vec::new()
            )
        );
    }

    #[test]
    fn ready_needs_every_parent_satisfied() {
        assert_eq!(
            ready(&ids(&["b", "c", "d"]), &diamond(), &known(&["a", "b"])),
            ids(&["b", "c"])
        );
        assert_eq!(
            ready(&ids(&["d"]), &diamond(), &known(&["a", "b", "c"])),
            ids(&["d"])
        );
        assert_eq!(
            ready(&ids(&["d"]), &diamond(), &known(&["a", "b"])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn critical_path_is_the_longest_chain_with_ties_to_the_smaller_id() {
        assert_eq!(
            critical_path(&ids(&["a", "b", "c", "d"]), &diamond()),
            ids(&["a", "b", "d"])
        );
        let two = parents(&[("z", &[]), ("y", &[])]);
        assert_eq!(critical_path(&ids(&["z", "y"]), &two), ids(&["y"]));
        assert_eq!(critical_path(&[], &Parents::new()), Vec::<String>::new());
        assert_eq!(
            critical_path(&ids(&["a"]), &parents(&[("a", &["a"])])),
            Vec::<String>::new()
        );
    }

    #[test]
    fn bottlenecks_count_transitive_dependents() {
        assert_eq!(
            bottlenecks(&ids(&["a", "b", "c", "d"]), &diamond(), BOTTLENECK_LIMIT),
            vec![
                ("a".to_string(), 3),
                ("b".to_string(), 1),
                ("c".to_string(), 1)
            ]
        );
        assert_eq!(
            bottlenecks(&ids(&["a", "b", "c", "d"]), &diamond(), 1),
            vec![("a".to_string(), 3)]
        );
        assert_eq!(
            bottlenecks(&ids(&["a", "b"]), &Parents::new(), BOTTLENECK_LIMIT),
            Vec::new()
        );
    }

    fn scopes(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        pairs
            .iter()
            .map(|(node, listed)| {
                (
                    (*node).to_string(),
                    listed.iter().map(|value| (*value).to_string()).collect(),
                )
            })
            .collect()
    }

    fn pair(first: &str, second: &str, shared: &[&str]) -> ScopePair {
        ScopePair {
            first: first.to_string(),
            second: second.to_string(),
            // A set, as the original's `shared` is: two entries written the same are one entry.
            shared: shared
                .iter()
                .map(|value| (*value).to_string())
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect(),
            joined: false,
        }
    }

    #[test]
    fn pairs_name_the_shared_entries_and_whether_a_direct_edge_joins_them() {
        let listed = scopes(&[
            ("a", &["x.py", "y.py"]),
            ("b", &["y.py"]),
            ("c", &["y.py"]),
            ("d", &["z.py"]),
        ]);
        let edges = parents(&[("b", &["a"]), ("c", &["b"])]);
        assert_eq!(
            shared_scope_pairs(&listed, &edges, false),
            vec![
                ScopePair {
                    joined: true,
                    ..pair("a", "b", &["y.py"])
                },
                pair("a", "c", &["y.py"]),
                ScopePair {
                    joined: true,
                    ..pair("b", "c", &["y.py"])
                },
            ]
        );
    }

    #[test]
    fn as_written_a_directory_and_a_file_under_it_do_not_meet() {
        assert_eq!(
            shared_scope_pairs(
                &scopes(&[("a", &["src/"]), ("b", &["src/x.py"])]),
                &Parents::new(),
                false
            ),
            Vec::new()
        );
    }

    #[test]
    fn as_paths_entries_written_differently_meet() {
        let meeting: &[(&str, &str)] = &[
            ("src/", "src/x.py"),
            ("src", "src/x.py"),
            ("src/x.py", "./src/x.py"),
            ("src//x.py", "src/x.py"),
            ("src/x.py/", "src/x.py"),
            ("src/*.py", "src/x.py"),
            ("src/*.py", "src/lib/y.py"),
            ("tests/test_*.py", "tests/test_b.py"),
            ("*.md", "docs/a.md"),
            (".", "a.py"),
            ("SRC/X.py", "src/x.py"),
            ("src/a?.py", "src/a1.py"),
            ("src\\x.py", "src/x.py"),
            // A CRLF list read from a file, and a stray space either side.
            ("src/a.rs\r", "src/a.rs"),
            ("  src/b.rs  \r\n", "src/b.rs"),
            ("src/../lib/x.py", "lib/x.py"),
            ("/src/x.py", "/src/x.py"),
            ("app/[slug]/*.tsx", "app/[slug]/page.tsx"),
            // A glob beside a directory or another glob meets by its directory: a name with no suffix may be one.
            ("src/*.py", "src/lib"),
            ("src/*.py", "src/"),
            ("src/*.py", "src/*.md"),
            ("*.md", "src/"),
            ("*.md", "docs/v1.2/"),
            // `**/` matches zero directories too.
            ("src/**/*.py", "src/x.py"),
            ("**/*.md", "README.md"),
            ("tests/**/test_*.py", "tests/test_x.py"),
            ("docs/**/*.md", "docs/a.md"),
            ("**/*.py", "x.py"),
            ("src/**/*.py", "src/a/b/x.py"),
        ];
        let apart: &[(&str, &str)] = &[
            ("src/a", "src/ab"),
            ("docs/x.md", "docs/xy.md"),
            ("src/*.py", "lib/x.py"),
            ("src/a/", "src/ab/c.py"),
            ("app/[slug]/page.tsx", "app/about/page.tsx"),
            ("/src/x.py", "lib/x.py"),
            ("/src/x.py", "src/x.py"),
            ("*.md", "src/x.py"),
            ("src/*.py", "src/x.md"),
            ("tests/test_a*.py", "tests/test_b.py"),
        ];
        for (first, second) in meeting {
            assert_eq!(
                shared_scope_pairs(
                    &scopes(&[("a", &[first]), ("b", &[second])]),
                    &Parents::new(),
                    true
                ),
                vec![pair("a", "b", &[first, second])],
                "{first} vs {second} should meet"
            );
        }
        for (first, second) in apart {
            assert_eq!(
                shared_scope_pairs(
                    &scopes(&[("a", &[first]), ("b", &[second])]),
                    &Parents::new(),
                    true
                ),
                Vec::new(),
                "{first} vs {second} should stay apart"
            );
        }
    }

    #[test]
    fn as_paths_names_each_meeting_entry_as_written_and_keeps_the_direct_edge_rule() {
        let listed = scopes(&[
            ("a", &["src/", "README.md"]),
            ("b", &["./src/x.py", "src/y.py", "docs/b.md"]),
            ("c", &["src/x.py"]),
        ]);
        let edges = parents(&[("b", &["a"]), ("c", &["b"])]);
        assert_eq!(
            shared_scope_pairs(&listed, &edges, true),
            vec![
                ScopePair {
                    joined: true,
                    ..pair("a", "b", &["./src/x.py", "src/", "src/y.py"])
                },
                pair("a", "c", &["src/", "src/x.py"]),
                ScopePair {
                    joined: true,
                    ..pair("b", "c", &["./src/x.py", "src/x.py"])
                },
            ]
        );
    }
}
