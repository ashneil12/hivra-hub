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
    let mut command = Command::new(bundle_binary(app));
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
}
