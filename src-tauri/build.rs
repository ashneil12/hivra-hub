use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // generate_context! embeds icons; cargo ignores them unless we watch here.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=macos/Assets.car");
    build_stamp();
    default_plugins();
    // WP-44: the desktop plugin is carried, but it is not a default, so it stays off.
    desktop_control();
    // GNU ld exports every symbol from the Tauri cdylib and blows past the
    // 65535 PE ordinal limit. Hide them; the desktop exe links the rlib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg-cdylib=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    // The hub plugin's commands get their permissions here (capabilities/default.json allows `hub:default`).
    // WP-04: the Ash OS bridge's commands are gone; the local store and the one-time import took their place.
    let hub = tauri_build::InlinedPlugin::new()
        .commands(&[
            "local_hub_read",
            "local_hub_write",
            "local_hub_make_folder",
            "ash_os_import_fetch",
            "connector_login_store",
            "connector_login_exists",
            "connector_login_delete",
            // WP-92: the saved login moves into the vault (registered in hub_plugin.rs).
            "connector_move_login_to_vault",
            // WP-92: the secret vault.
            "secrets_list",
            "secrets_pending",
            "secrets_requests",
            "secrets_save_new",
            "secrets_begin_save",
            "secrets_save",
            "secrets_decline",
            "secrets_request",
            "secrets_rename",
            "secrets_rotate",
            "secrets_delete",
            "secrets_reveal",
            "secrets_grants",
            "secrets_revoke_grant",
            "secrets_grant",
            "secrets_env_write",
            "secrets_env_remove",
            "secrets_slug",
            "secrets_index",
            "secrets_env_files",
            "secrets_worker_arm",
            "secrets_always_for_any_code",
            "secrets_set_always_for_any_code",
            "connectors_state",
            "connector_save_login",
            "connector_turn_on",
            "connector_save_google_client",
            "connector_forget_google_client",
            "connector_oauth",
            "connector_oauth_cancel",
            "connector_sign_out",
            "connector_test",
            "connector_set_allow",
            "connector_set_mono",
            "connectors_set_composio",
            "model_key_save",
            "model_key_test",
            "model_key_delete",
            // WP-22: a room's auto responder asks the quick model through this.
            "model_quick_pick",
            // WP-103: the cheap memory tier, and its "Test this model" check.
            "memory_cheap_ask",
            "memory_cheap_test",
            // WP-129: short text. One completion, no tools and no path.
            "text_generation_ask",
            "text_generation_remember",
            "text_generation_forget",
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

/// WP-41: every folder in `plugins/` (the default plugins, pinned in `plugins/defaults.json`) is embedded in the binary,
/// so the first start installs them with no download and no bundle resources (Linux and Windows builds carry none).
/// Writes `$OUT_DIR/default_plugins.rs`: `(folder, path inside it with `/`, bytes, executable)`, sorted. A file is
/// executable when it starts with `#!`, so the answer doesn't depend on the platform the app was built on.
fn default_plugins() {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, std::path::PathBuf)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("plugins folder")
            .flatten()
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).expect("plugin file");
            if meta.file_type().is_symlink() {
                panic!(
                    "{} is a link: default plugins are plain files",
                    path.display()
                );
            }
            if meta.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap();
                let rel: Vec<_> = rel
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                out.push((rel.join("/"), path));
            }
        }
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest_dir).join("plugins");
    println!("cargo:rerun-if-changed=plugins");
    let mut code = String::from("pub static FILES: &[(&str, &str, &[u8], bool)] = &[\n");
    let mut folders: Vec<_> = std::fs::read_dir(&root)
        .expect("plugins folder")
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    folders.sort_by_key(|e| e.file_name());
    for folder in folders {
        let name = folder.file_name().to_string_lossy().into_owned();
        let mut files = Vec::new();
        walk(&folder.path(), &folder.path(), &mut files);
        for (rel, path) in files {
            let executable = std::fs::read(&path)
                .map(|bytes| bytes.starts_with(b"#!"))
                .unwrap_or(false);
            code.push_str(&format!(
                "    ({name:?}, {rel:?}, include_bytes!({:?}), {executable}),\n",
                path.to_string_lossy()
            ));
        }
    }
    code.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("default_plugins.rs");
    std::fs::write(out, code).expect("default_plugins.rs");
}

/// WP-44: `plugins/desktop-control` at the repo root, embedded on its own so it is not a default plugin.
fn desktop_control() {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, std::path::PathBuf)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("desktop-control folder")
            .flatten()
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path).expect("desktop-control file");
            if meta.file_type().is_symlink() {
                panic!(
                    "{} is a link: the carried plugin is plain files",
                    path.display()
                );
            }
            if meta.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap();
                let rel: Vec<_> = rel
                    .iter()
                    .map(|part| part.to_string_lossy().into_owned())
                    .collect();
                out.push((rel.join("/"), path));
            }
        }
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest_dir).join("../plugins/desktop-control");
    println!("cargo:rerun-if-changed=../plugins/desktop-control");
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    let mut code = String::from("pub static FILES: &[(&str, &[u8], bool)] = &[\n");
    for (rel, path) in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let executable = std::fs::read(path)
            .map(|bytes| bytes.starts_with(b"#!"))
            .unwrap_or(false);
        code.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?}), {executable}),\n",
            path.to_string_lossy()
        ));
    }
    code.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("desktop_control.rs");
    std::fs::write(out, code).expect("desktop_control.rs");
}
