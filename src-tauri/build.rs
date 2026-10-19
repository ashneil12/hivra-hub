use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // generate_context! embeds icons; cargo ignores them unless we watch here.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=macos/Assets.car");
    build_stamp();
    // GNU ld exports every symbol from the Tauri cdylib and blows past the
    // 65535 PE ordinal limit. Hide them; the desktop exe links the rlib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg-cdylib=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    // The hub plugin's three commands get their permissions here (capabilities/default.json allows `hub:default`).
    let hub = tauri_build::InlinedPlugin::new()
        .commands(&[
            "hub_call",
            "hub_events_open",
            "hub_events_close",
            "hub_ash_os_mcp",
            "connector_login_store",
            "connector_login_exists",
            "connector_login_delete",
            "model_key_save",
            "model_key_test",
            "model_key_delete",
        ])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("hub", hub))
        .expect("failed to run tauri-build");
}

/// Which commit this binary was built from (`src/instance.rs` reads it back). The line
/// `MONOCODE-STAMP:{"sha","branch","dirty","builtAt"}` ends up in the binary as one string, so a script can read it from
/// any bundle without launching it.
///
/// `dirty` means tracked files differed from the commit when this ran; untracked files don't count. The script reruns
/// when HEAD moves (its reflog, and the branch ref when it is a loose file), when a Rust source or manifest changes,
/// and when the frontend build in `../dist` changes, which every `tauri build` rewrites. Tauri itself doesn't watch
/// `dist` here (the context comes from the `generate_context!` macro), so this script must. A frontend-only edit
/// between builds without `tauri build` (e.g. `cargo test`) keeps the last stamp; Ship checks the tree itself.
fn build_stamp() {
    let git = |args: &[&str]| -> Option<String> {
        let output = Command::new("git").args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let sha = git(&["rev-parse", "HEAD"]).filter(|sha| !sha.is_empty());
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).filter(|branch| !branch.is_empty());
    // --no-optional-locks: never rewrite the index from a build, or the next build would see it change and run again.
    let dirty = git(&[
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--untracked-files=no",
    ])
    .map(|status| !status.is_empty());

    // Only paths that exist: cargo reruns a build script on every build for a missing one.
    let watch = |path: String| {
        if Path::new(&path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    };
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        watch(format!("{git_dir}/HEAD"));
        // Every commit, checkout or reset appends here, even when the branch ref is packed.
        watch(format!("{git_dir}/logs/HEAD"));
    }
    if let Some(common) = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]) {
        watch(format!("{common}/packed-refs"));
        if let Some(branch) = branch.as_deref().filter(|b| *b != "HEAD") {
            watch(format!("{common}/refs/heads/{branch}"));
        }
    }
    for path in [
        "src",
        "Cargo.toml",
        "../Cargo.toml",
        "../Cargo.lock",
        "../crates",
        "../dist",
    ] {
        watch(path.to_string());
    }

    let stamp = serde_json::json!({
        "sha": sha.unwrap_or_else(|| "unknown".into()),
        "branch": match branch.as_deref() {
            None => "unknown".to_string(),
            Some("HEAD") => "detached".to_string(),
            Some(branch) => branch.to_string(),
        },
        // Unknown counts as dirty: a build whose source can't be named is never a clean one.
        "dirty": dirty.unwrap_or(true),
        "builtAt": rfc3339_utc(SystemTime::now()),
    });
    println!("cargo:rustc-env=MONOCODE_BUILD_STAMP={stamp}");
}

/// `2026-10-19T21:04:05Z`, without a date crate in the build script.
fn rfc3339_utc(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}
