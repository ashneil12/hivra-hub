//! r82: the worker routes check, run by the app itself when a delegated worker reports done (s14: the bench ran it from
//! outside each worker's copy; now the app does). A check lives in the app's data folder, never in a project:
//! `<app data>/gates/<project id>.json` names it and its script, which sits beside it, so no worker can edit it to get
//! past a decision. `{"name": "Routes check", "script": "tally-routes.mjs", "signOff": ["DELETE /tallies/:id"]}`.
//! The script gets the worker's checkout, and `--signed-off <item>` for each `signOff` item once Ash has answered.
//! Exit 0 passes; anything else fails with its output, which goes back to the worker in words.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub(crate) const GATE_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const OUTPUT_MAX: usize = 2000;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GateConfig {
    #[serde(default)]
    pub name: Option<String>,
    pub script: String,
    #[serde(default)]
    pub sign_off: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateRun {
    pub name: String,
    pub ok: bool,
    pub output: String,
}

/// A project id as a file name: letters, digits, dot, dash, underscore; never a path or a hidden file.
pub(crate) fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The project's check, if it has one: its config and its script's path, both inside `dir`.
pub(crate) fn gate_for(
    dir: &Path,
    project_id: &str,
) -> Result<Option<(GateConfig, PathBuf)>, String> {
    if !safe_id(project_id) {
        return Err("That project id can't name a check.".into());
    }
    let file = dir.join(format!("{project_id}.json"));
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(None);
    };
    let config: GateConfig = serde_json::from_str(&text)
        .map_err(|e| format!("The check's settings couldn't be read: {e}"))?;
    if !safe_id(&config.script) || config.script.ends_with(".json") {
        return Err("The check's script has to be a file beside its settings.".into());
    }
    let script = dir.join(&config.script);
    if !script.is_file() {
        return Err(format!("The check's script {} isn't there.", config.script));
    }
    Ok(Some((config, script)))
}

/// A worker's own checkout: a folder inside the project's sibling `<project>-worktrees/` folder.
pub(crate) fn worker_checkout(checkout: &str) -> Result<PathBuf, String> {
    let path = crate::fs::canonical(checkout)
        .map_err(|_| "The worker's checkout isn't there.".to_string())?;
    let in_worktrees = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with("-worktrees"));
    if !path.is_dir() || !in_worktrees {
        return Err("A check only runs on a worker's own checkout.".into());
    }
    Ok(path)
}

/// The last `max` characters of `text`, on a char boundary.
pub(crate) fn tail(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

/// Run one check: node for a .mjs/.js/.ts script, else the script itself. Never longer than `timeout`.
pub(crate) fn run_script(
    script: &Path,
    checkout: &Path,
    signed_off: &[String],
    path_env: Option<String>,
    timeout: Duration,
) -> (bool, String) {
    let ext = script.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut cmd = if matches!(ext, "mjs" | "js" | "ts" | "cjs") {
        let mut c = Command::new("node");
        c.args(["--experimental-strip-types", "--no-warnings"])
            .arg(script);
        c
    } else {
        Command::new(script)
    };
    cmd.arg(checkout);
    for item in signed_off {
        cmd.arg("--signed-off").arg(item);
    }
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    cmd.current_dir(script.parent().unwrap_or(Path::new("/")));
    run_collected(cmd, timeout, "check")
}

/// Run `cmd` with its output collected, never longer than `timeout`; `what` names it in its own failures ("check").
pub(crate) fn run_collected(mut cmd: Command, timeout: Duration, what: &str) -> (bool, String) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return (false, format!("The {what} couldn't start: {e}")),
    };
    // Read both pipes on their own threads so a chatty script can't fill one and stall.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break None,
        }
    };
    // Stopped: its pipes may stay open in a process it left behind, so its words aren't waited for.
    let Some(status) = status else {
        return (
            false,
            format!(
                "The {what} ran past {} seconds and was stopped.",
                timeout.as_secs()
            ),
        );
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    let said = format!("{}\n{}", stdout.trim(), stderr.trim());
    (status.success(), tail(&said, OUTPUT_MAX))
}

fn gates_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("gates"))
}

/// Run the project's check on a worker's checkout. `Ok(None)`: the project has no check.
#[tauri::command]
pub async fn run_worker_gate(
    app: AppHandle,
    project_id: String,
    checkout: String,
    signed_off: bool,
) -> Result<Option<GateRun>, String> {
    let dir = gates_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some((config, script)) = gate_for(&dir, &project_id)? else {
            return Ok(None);
        };
        let checkout = worker_checkout(&checkout)?;
        let items = if signed_off {
            config.sign_off.clone()
        } else {
            Vec::new()
        };
        let (ok, output) = run_script(
            &script,
            &checkout,
            &items,
            crate::harness::login_shell_path(),
            GATE_TIMEOUT,
        );
        Ok(Some(GateRun {
            name: config.name.unwrap_or_else(|| "Check".into()),
            ok,
            output,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("monocode-gates-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_and_scripts_are_plain_file_names() {
        assert!(safe_id("tally"));
        assert!(safe_id("local_tally-2.x"));
        assert!(!safe_id("../tally"));
        assert!(!safe_id(".hidden"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id(""));
    }

    #[test]
    fn no_settings_is_no_check_and_a_script_outside_is_refused() {
        let dir = temp("cfg");
        assert_eq!(gate_for(&dir, "tally").unwrap(), None);
        std::fs::write(dir.join("tally.json"), r#"{"script":"../evil.sh"}"#).unwrap();
        assert!(gate_for(&dir, "tally").is_err());
        std::fs::write(
            dir.join("tally.json"),
            r#"{"name":"Routes check","script":"routes.sh","signOff":["DELETE /x"]}"#,
        )
        .unwrap();
        assert!(gate_for(&dir, "tally").is_err(), "missing script");
        std::fs::write(dir.join("routes.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        let (config, script) = gate_for(&dir, "tally").unwrap().unwrap();
        assert_eq!(config.name.as_deref(), Some("Routes check"));
        assert_eq!(config.sign_off, vec!["DELETE /x".to_string()]);
        assert_eq!(script, dir.join("routes.sh"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_worker_checkout() {
        let dir = temp("co");
        let project = dir.join("tally");
        let worker = dir.join("tally-worktrees").join("mc-1");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&worker).unwrap();
        assert!(worker_checkout(project.to_str().unwrap()).is_err());
        assert!(worker_checkout(worker.to_str().unwrap()).is_ok());
        assert!(worker_checkout(dir.join("nope").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_script_with_the_checkout_and_sign_offs_and_keeps_its_words() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("run");
        let script = dir.join("check.sh");
        std::fs::write(&script, "#!/bin/sh\necho \"on $1 signed $3\"\n[ \"$3\" = \"DELETE /x\" ] && exit 0\necho 'DELETE /x is not signed off'\nexit 1\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (ok, said) = run_script(
            &script,
            Path::new("/tmp/co"),
            &[],
            None,
            Duration::from_secs(10),
        );
        assert!(!ok);
        assert!(said.contains("DELETE /x is not signed off"), "{said}");
        let (ok, said) = run_script(
            &script,
            Path::new("/tmp/co"),
            &["DELETE /x".into()],
            None,
            Duration::from_secs(10),
        );
        assert!(ok, "{said}");
        assert!(said.contains("on /tmp/co signed DELETE /x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_check_that_runs_too_long_is_stopped_and_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("slow");
        let script = dir.join("slow.sh");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 5\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A script written a moment ago can still be "busy" if another test's fork
        // copied its open write handle (ETXTBSY, seen on Linux CI). Try again; the
        // assertion still shows what was said if it never starts.
        let mut said = String::new();
        let mut ok = true;
        for _ in 0..5 {
            (ok, said) = run_script(
                &script,
                Path::new("/tmp"),
                &[],
                None,
                Duration::from_millis(300),
            );
            if !said.contains("Text file busy") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!ok, "{said}");
        assert!(said.contains("was stopped"), "{said}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_keeps_its_end() {
        let long = "x".repeat(3000) + "END";
        let t = tail(&long, 100);
        assert!(t.ends_with("END"));
        assert!(t.chars().count() <= 101);
    }
}
