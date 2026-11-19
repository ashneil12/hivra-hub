//! Branch and remote names that arrive from the database or a caller are untrusted.
//! A name that could change which ref a later git command writes is refused.

pub fn package_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 200 || token_rejected(id) {
        return Err("Which package?".into());
    }
    Ok(id)
}

pub fn remote_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 80
        || name.starts_with('-')
        || name.starts_with('.')
        || name.contains("..")
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("That remote name is not one this update will use.".into());
    }
    Ok(name)
}

pub fn branch_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 250 || unsafe_ref(name) {
        return Err("That branch name is not one this update will use.".into());
    }
    Ok(name)
}

/// `main`, `master`, and whatever base this update would bring in. The package
/// branch is never one of these, so the update cannot land on `main`.
pub fn is_protected(branch: &str, base: &str) -> bool {
    same(branch, "main") || same(branch, "master") || same(branch, base)
}

fn same(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn token_rejected(name: &str) -> bool {
    name.starts_with('-')
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn unsafe_ref(name: &str) -> bool {
    name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("@{")
        || name.contains("//")
        || name.chars().any(|c| {
            c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '\u{7f}')
        })
}
