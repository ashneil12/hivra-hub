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
    joined_hostname(project, label)
}

/// `<service>-<label>.localhost` for one emulated service.
pub fn service_hostname(service: &str, label: &str) -> Option<String> {
    joined_hostname(service, label)
}

fn joined_hostname(first: &str, label: &str) -> Option<String> {
    let first = sanitize_for_hostname(first);
    let label = sanitize_for_hostname(label);
    if first.is_empty() || label.is_empty() {
        return None;
    }
    let mut prefix = format!("{first}-{label}");
    if prefix.len() > MAX_LABEL {
        // Keep the pair unique and inside one label: the hash covers both halves.
        let hash = hex(&Sha256::digest(format!("{first}/{label}").as_bytes()));
        let keep = MAX_LABEL - 7;
        prefix.truncate(keep);
        while prefix.ends_with('-') {
            prefix.pop();
        }
        prefix = format!("{prefix}-{}", &hash[..6]);
    }
    let host = format!("{prefix}.localhost");
    valid_hostname(&host).then_some(host)
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
