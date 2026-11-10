// WP-09: the app side of a ship on Windows and Linux.
// The swap itself stays in the Node runner. This restarts that runner from the
// service script the ship recorded, and opens the bundle without Launch Services.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

/// The binary inside a bundle. Windows prefers `monocode.exe` when the build produced one.
pub fn bundle_binary(app: &Path) -> PathBuf {
    let binary = app.join("Contents").join("MacOS").join("monocode");
    #[cfg(target_os = "windows")]
    {
        let exe = binary.with_extension("exe");
        if exe.is_file() {
            return exe;
        }
    }
    binary
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn spawn_app(app: &Path) -> std::io::Result<()> {
    spawn_app_env(app, &[])
}

/// Open the bundle binary, then overlay `env` on the inherited environment.
/// Direct reopen uses this on every OS so Windows runs `monocode.exe`.
pub fn spawn_app_env(app: &Path, env: &[(String, String)]) -> std::io::Result<()> {
    let mut command = Command::new(bundle_binary(app));
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Leave the quitting build's process group, or the new one dies with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ())
}

/// Re-run the task or unit script stored on the ship. False when this ship has none,
/// so the caller falls through to the detached node process.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn rerun(doc: &Value, dir: &Path) -> bool {
    let Some(kind) = doc.pointer("/service/kind").and_then(Value::as_str) else {
        return false;
    };
    let Some(script) = doc.pointer("/service/script").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "task" => run_task(script).is_ok(),
        "systemd" => run_systemd(script, dir, doc).is_ok(),
        _ => false,
    }
}

fn run_task(script: &str) -> Result<(), ()> {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let bin = PathBuf::from(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let mut command = Command::new(bin);
        command
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        allow_listed(
            &mut command,
            &[
                "ALLUSERSPROFILE",
                "APPDATA",
                "COMSPEC",
                "HOME",
                "HOMEDRIVE",
                "HOMEPATH",
                "LOCALAPPDATA",
                "PATH",
                "PATHEXT",
                "PROCESSOR_ARCHITECTURE",
                "PROGRAMDATA",
                "SystemRoot",
                "TEMP",
                "TMP",
                "USERNAME",
                "USERPROFILE",
                "WINDIR",
            ],
        );
        let mut child = command.spawn().map_err(|_| ())?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(script.as_bytes());
        }
        // Dropping stdin closes the pipe before the wait, so PowerShell can finish.
        let status = child.wait().map_err(|_| ())?;
        if status.success() {
            Ok(())
        } else {
            Err(())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = script;
        Err(())
    }
}

fn run_systemd(script: &str, dir: &Path, doc: &Value) -> Result<(), ()> {
    let name = doc
        .pointer("/service/unitName")
        .and_then(Value::as_str)
        .filter(|name| {
            name.ends_with(".service")
                && !name.contains('/')
                && !name.contains('\\')
                && !name.contains("..")
                && !name.is_empty()
        })
        .ok_or(())?;
    let path = dir.join(name);
    if !path.starts_with(dir) || path == dir {
        return Err(());
    }
    std::fs::write(&path, script).map_err(|_| ())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let bin = std::env::var("MONOCODE_SHIP_SYSTEMCTL").unwrap_or_else(|_| "systemctl".into());
    // Link the unit where it already lives, then start it. Same two calls as hub-ship.mjs.
    if !systemctl(&bin, &["--user", "link", &path.to_string_lossy()])? {
        return Err(());
    }
    if !systemctl(&bin, &["--user", "start", name])? {
        return Err(());
    }
    Ok(())
}

fn systemctl(bin: &str, args: &[&str]) -> Result<bool, ()> {
    let mut command = Command::new(bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    allow_listed(
        &mut command,
        &[
            "HOME",
            "PATH",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
        ],
    );
    let status = command.status().map_err(|_| ())?;
    Ok(status.success())
}

/// The parent's secrets stay out. Empty values are left unset.
fn allow_listed(command: &mut Command, keys: &[&str]) {
    command.env_clear();
    for key in keys {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                command.env(key, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::bundle_binary;
    use std::path::Path;

    #[test]
    fn the_bundle_binary_stays_inside_the_app() {
        let app = Path::new("/tmp/MonoCode Hub.app");
        let binary = bundle_binary(app);
        assert!(binary.starts_with(app));
        assert!(binary.ends_with("Contents/MacOS/monocode") || binary.ends_with("monocode.exe"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_app_env_runs_the_bundle_binary_with_the_ship_env() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("wp09-spawn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let app = root.join("MonoCode Hub.app");
        let bin_dir = app.join("Contents").join("MacOS");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let marker = root.join("marker");
        let script = bin_dir.join("monocode");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s' \"$WP09_MARKER\" > \"$WP09_MARKER_PATH\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = [
            ("WP09_MARKER".to_string(), "kept".to_string()),
            (
                "WP09_MARKER_PATH".to_string(),
                marker.to_string_lossy().into_owned(),
            ),
        ];
        // A script written a moment ago can still be "busy" when another test's fork copied
        // its open write handle (ETXTBSY, seen on Linux CI). Try again for a moment.
        let mut tries = 0;
        loop {
            match super::spawn_app_env(&app, &env) {
                Err(why) if why.raw_os_error() == Some(libc::ETXTBSY) && tries < 50 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                other => break other.unwrap(),
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let text = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(text, "kept");
    }
}
