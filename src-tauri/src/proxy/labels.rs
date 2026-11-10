// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/auto.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// Translated to Rust for Hivra WP-90. The label rules are portless's; the worktree-prefix
// heuristic is not (Hivra always knows its stack).

//! Hostname labels for one stack: lowercase, one DNS label each, never repaired into a name.
//!
//! portless's `sanitizeForHostname` repairs a branch for use as a prefix, and `truncateLabel`
//! keeps a label inside the 63-character DNS limit. Hivra derives a name from the stack id (a
//! pool slot keeps it when re-leased) or, outside the pool, from the worktree's branch.

use sha2::{Digest, Sha256};

/// Maximum length of one DNS label (RFC 1035).
pub const MAX_LABEL: usize = 63;
/// Maximum length of a whole hostname (RFC 1035).
pub const MAX_HOSTNAME: usize = 253;

/// Truncate a DNS label, keeping uniqueness with six hex digits of the label's SHA-256.
pub fn truncate_label(label: &str) -> String {
    if label.len() <= MAX_LABEL {
        return label.to_string();
    }
    let hash = hex(&Sha256::digest(label.as_bytes()));
    // A name read from disk is untrusted, so cut on a character boundary, never a byte.
    let mut prefix = String::new();
    for ch in label.chars() {
        if prefix.len() + ch.len_utf8() > MAX_LABEL - 7 {
            break;
        }
        prefix.push(ch);
    }
    let prefix = prefix.trim_end_matches('-');
    format!("{prefix}-{}", &hash[..6])
}

/// portless's `sanitizeForHostname`: lowercase, invalid characters become hyphens, runs of
/// hyphens collapse, the ends are trimmed, and the result fits one label.
pub fn sanitize_for_hostname(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_hyphen = false;
    for ch in name.to_lowercase().chars() {
        let keep = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        if keep {
            out.push(ch);
            last_hyphen = false;
        } else if !last_hyphen && !out.is_empty() {
            out.push('-');
            last_hyphen = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    truncate_label(&out)
}

/// Whether `name` is one DNS label this app may publish, exactly as written.
///
/// A name that fails is refused, never repaired: a space, a unicode letter, `..`, a path
/// separator, a wildcard or an empty string never reaches the registry.
pub fn valid_label(name: &str) -> bool {
    let len = name.len();
    if len == 0 || len > MAX_LABEL {
        return false;
    }
    let bytes = name.as_bytes();
    let first = bytes[0];
    let last = bytes[len - 1];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    if !(last.is_ascii_lowercase() || last.is_ascii_digit()) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Whether `host` is a name this app publishes: one or more valid labels and the `.localhost`
/// suffix. Nothing else is handed to the proxy, so a `routes.json` naming another domain is
/// refused rather than becoming a route.
pub fn valid_hostname(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOSTNAME {
        return false;
    }
    if host.contains("..") || host.contains(['/', '\\', '*', '@', ':']) {
        return false;
    }
    let Some(labels) = host.strip_suffix(".localhost") else {
        return false;
    };
    !labels.is_empty() && labels.split('.').all(valid_label)
}

/// The label a stack publishes: the stack id for a pool slot (stable across a return and a
/// new lease), otherwise the worktree's branch, with the id when there is no usable branch.
pub fn stack_label(id: &str, branch: Option<&str>, pool_slot: bool) -> Option<String> {
    if pool_slot {
        return Some(sanitize_for_hostname(id)).filter(|label| !label.is_empty());
    }
    let from_branch = branch
        .map(str::trim)
        .filter(|branch| !branch.is_empty() && *branch != "HEAD")
        .filter(|branch| *branch != "main" && *branch != "master")
        .map(sanitize_for_hostname)
        .filter(|label| !label.is_empty());
    from_branch.or_else(|| {
        let from_id = sanitize_for_hostname(id);
        (!from_id.is_empty()).then_some(from_id)
    })
}

/// `<project>-<label>.localhost` for the app itself.
pub fn app_hostname(project: &str, label: &str) -> Option<String> {
    let host = format!("{}.localhost", joined_label(project, label)?);
    valid_hostname(&host).then_some(host)
}

/// `<service>.<project>-<label>.localhost` for one emulated service.
///
/// The service is a label of its own, with a dot after it. A hyphen would not do: a project
/// named `github-shop` on branch `a` is the app `github-shop-a.localhost`, which is also what
/// project `shop`'s fake GitHub on branch `a` would be called. An app is always one label and
/// a service two, so no project or branch spelled with hyphens can make one read as the other.
/// The project is in the name so two projects on the same branch, both faking the same
/// service, do not publish one hostname.
pub fn service_hostname(service: &str, project: &str, label: &str) -> Option<String> {
    let service = sanitize_for_hostname(service);
    if service.is_empty() {
        return None;
    }
    let host = format!("{service}.{}.localhost", joined_label(project, label)?);
    valid_hostname(&host).then_some(host)
}

/// The project's part of every name it publishes: the folder's name, and when another project
/// folder of the same name has a stack here too, a short hash of this folder's path as well.
/// Two folders called `shop` on one branch would otherwise be one name, and the second would
/// be refused. `path_key` is the project's canonical path; it is hashed, never shown.
pub fn project_label(folder: &str, path_key: &str, name_is_shared: bool) -> String {
    let name = sanitize_for_hostname(folder);
    if !name_is_shared {
        return name;
    }
    let hash = hex(&Sha256::digest(path_key.as_bytes()));
    let short = &hash[..PROJECT_HASH];
    if name.is_empty() {
        short.to_string()
    } else {
        // Too long with a branch for one label is shortened again by `joined_label`.
        format!("{name}-{short}")
    }
}

/// Hex digits of the path hash a shared project name carries.
const PROJECT_HASH: usize = 6;

/// `<first>-<label>`, kept inside one DNS label. A pair too long for one label is cut and
/// given the hash of both halves, so a shortened pair stays unique.
fn joined_label(first: &str, label: &str) -> Option<String> {
    let first = sanitize_for_hostname(first);
    let label = sanitize_for_hostname(label);
    if first.is_empty() || label.is_empty() {
        return None;
    }
    let mut prefix = format!("{first}-{label}");
    if prefix.len() > MAX_LABEL {
        let hash = hex(&Sha256::digest(format!("{first}/{label}").as_bytes()));
        let keep = MAX_LABEL - 7;
        prefix.truncate(keep);
        while prefix.ends_with('-') {
            prefix.pop();
        }
        prefix = format!("{prefix}-{}", &hash[..6]);
    }
    Some(prefix)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_worktrees_get_different_names_and_the_same_one_after_a_restart() {
        let one = stack_label("saaaaaaaa", Some("wp/one"), false).unwrap();
        let two = stack_label("sbbbbbbbb", Some("wp/two"), false).unwrap();
        assert_ne!(one, two);
        assert_eq!(
            one,
            stack_label("saaaaaaaa", Some("wp/one"), false).unwrap()
        );
        assert_eq!(
            app_hostname("shop", &one).unwrap(),
            app_hostname("shop", &one).unwrap()
        );
        assert_ne!(
            app_hostname("shop", &one).unwrap(),
            app_hostname("shop", &two).unwrap()
        );
    }

    #[test]
    fn a_pool_slot_keeps_its_name_when_returned_and_leased_again() {
        // The slot's stack id and its slot id both survive the return; the branch need not.
        let first = stack_label("s0123abcd", Some("wp/old"), true).unwrap();
        let second = stack_label("s0123abcd", Some("wp/new"), true).unwrap();
        assert_eq!(first, "s0123abcd");
        assert_eq!(first, second);
        assert_eq!(
            app_hostname("shop", &first).unwrap(),
            "shop-s0123abcd.localhost"
        );
    }

    #[test]
    fn a_two_hundred_character_branch_becomes_63_with_its_hash() {
        let branch = "a".repeat(200);
        let label = stack_label("s01234567", Some(&branch), false).unwrap();
        assert_eq!(label.len(), MAX_LABEL);
        assert!(valid_label(&label));
        let digest = hex(&Sha256::digest(branch.as_bytes()));
        assert!(label.ends_with(&digest[..6]));
        // The same long branch gives the same name every time.
        assert_eq!(
            label,
            stack_label("s01234567", Some(&branch), false).unwrap()
        );
    }

    #[test]
    fn spaces_unicode_dotdot_a_windows_path_and_an_empty_name_are_refused() {
        for bad in [
            "a b",
            "café",
            "..",
            "a/../b",
            "a\\b",
            "C:\\work\\shop",
            "",
            "-lead",
            "lead-",
            "UPPER",
            "*",
            "a..b",
        ] {
            assert!(!valid_label(bad), "{bad:?} must not be a name");
        }
        for good in ["shop", "wp-90", "s0123abcd", "a1"] {
            assert!(valid_label(good), "{good:?} must be a name");
        }
    }

    #[test]
    fn a_hostname_is_made_of_valid_labels_and_never_with_a_path_or_userinfo() {
        assert!(valid_hostname("shop-wp-90.localhost"));
        assert!(valid_hostname("github-s0123.localhost"));
        for bad in [
            "shop..localhost",
            "shop/wt.localhost",
            "user@shop.localhost",
            "shop.localhost:7400",
            ".localhost",
            "shop.localhost.",
            // Hivra publishes nothing outside `.localhost`; a hand-edited registry entry for
            // another domain is not a name this app made.
            "shop.example",
            "www.googleapis.com",
            "localhost",
        ] {
            assert!(!valid_hostname(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn sanitize_repairs_a_branch_before_it_is_used_as_a_label() {
        assert_eq!(sanitize_for_hostname("feat/My Shop"), "feat-my-shop");
        assert_eq!(sanitize_for_hostname("  ..a  b..  "), "a-b");
        assert_eq!(sanitize_for_hostname("café"), "caf");
        assert_eq!(sanitize_for_hostname(""), "");
    }

    #[test]
    fn a_service_name_carries_the_project_so_one_branch_can_serve_two() {
        let shop = service_hostname("github", "shop", "feature").unwrap();
        let blog = service_hostname("github", "blog", "feature").unwrap();
        assert_eq!(shop, "github.shop-feature.localhost");
        assert_eq!(blog, "github.blog-feature.localhost");
        assert_ne!(shop, blog);
        assert_eq!(shop, service_hostname("github", "shop", "feature").unwrap());
        // A project or a service that is not a label is repaired, never published raw.
        assert_eq!(
            service_hostname("Git Hub", "My Shop", "feat/one").unwrap(),
            "git-hub.my-shop-feat-one.localhost"
        );
        assert!(service_hostname("", "shop", "feature").is_none());
        assert!(service_hostname("github", "", "feature").is_none());
        let long = service_hostname(&"g".repeat(40), &"p".repeat(40), &"l".repeat(40)).unwrap();
        assert!(valid_hostname(&long), "{long}");
        for label in long.strip_suffix(".localhost").unwrap().split('.') {
            assert!(label.len() <= MAX_LABEL, "{long}");
        }
    }

    /// Joining with a hyphen made `github-shop-a.localhost` two different things: project
    /// `github-shop`'s app on branch `a`, and project `shop`'s fake GitHub on branch `a`. The
    /// second would be refused, or (before the registry held names per stack) replace the first.
    #[test]
    fn a_fake_service_never_has_the_name_of_another_projects_app() {
        let app = app_hostname("github-shop", "a").unwrap();
        let fake = service_hostname("github", "shop", "a").unwrap();
        assert_eq!(app, "github-shop-a.localhost");
        assert_eq!(fake, "github.shop-a.localhost");
        assert_ne!(app, fake);
        // An app is one label and a service is two, whatever hyphens the parts carry.
        for (project, label) in [
            ("shop", "a"),
            ("github-shop", "a"),
            ("github", "shop-a"),
            ("a-b", "c-d"),
        ] {
            let app = app_hostname(project, label).unwrap();
            let fake = service_hostname("github", project, label).unwrap();
            let app_labels = app.strip_suffix(".localhost").unwrap().split('.').count();
            let fake_labels = fake.strip_suffix(".localhost").unwrap().split('.').count();
            assert_eq!(app_labels, 1, "{app}");
            assert_eq!(fake_labels, 2, "{fake}");
            assert!(valid_hostname(&app) && valid_hostname(&fake));
        }
        // Two services of one project stay apart.
        assert_ne!(
            service_hostname("github", "shop", "a").unwrap(),
            service_hostname("stripe", "shop", "a").unwrap()
        );
    }

    #[test]
    fn two_project_folders_with_one_name_get_a_path_hash_only_when_the_name_repeats() {
        // Alone, the folder's name is the whole project part.
        assert_eq!(project_label("shop", "/work/a/shop", false), "shop");
        assert_eq!(
            project_label("My Shop", "/work/a/my shop", false),
            "my-shop"
        );
        // Sharing a name, each carries a short hash of its own path.
        let first = project_label("shop", "/work/a/shop", true);
        let second = project_label("shop", "/work/b/shop", true);
        assert_ne!(first, second);
        for part in [&first, &second] {
            assert!(part.starts_with("shop-"), "{part}");
            assert_eq!(part.len(), "shop-".len() + 6, "{part}");
            assert!(valid_label(part), "{part}");
        }
        // The same folder gets the same part every time, so its name survives a restart.
        assert_eq!(first, project_label("shop", "/work/a/shop", true));
        // One branch, two folders called shop: two apps and two fake services, no clash.
        assert_ne!(
            app_hostname(&first, "a").unwrap(),
            app_hostname(&second, "a").unwrap()
        );
        assert_ne!(
            service_hostname("github", &first, "a").unwrap(),
            service_hostname("github", &second, "a").unwrap()
        );
        // A folder with no letters or digits of its own is told apart by the hash alone.
        let bare = project_label("日本", "/work/a/日本", true);
        assert_eq!(bare.len(), 6, "{bare}");
        assert!(valid_label(&bare));
    }

    #[test]
    fn a_main_or_missing_branch_falls_back_to_the_stack_id() {
        assert_eq!(
            stack_label("sabcdef12", Some("main"), false).unwrap(),
            "sabcdef12"
        );
        assert_eq!(
            stack_label("sabcdef12", Some("HEAD"), false).unwrap(),
            "sabcdef12"
        );
        assert_eq!(stack_label("sabcdef12", None, false).unwrap(), "sabcdef12");
    }
}
