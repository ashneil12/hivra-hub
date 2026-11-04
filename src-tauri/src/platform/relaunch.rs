// WP-09: relaunch the app after a crash.
// macOS keeps its LaunchAgent (autopilot.rs `install_agent`). Windows uses Task Scheduler
// and Linux a systemd user timer. The watcher interval stays 30s, except Windows, where
// Task Scheduler's shortest repetition is one minute.

#[cfg(not(target_os = "macos"))]
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::process::Command;

/// Where the watcher's file goes. On macOS this is the LaunchAgent plist, unchanged.
pub fn agent_file(home: &Path, label: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library/LaunchAgents")
            .join(format!("{label}.plist"))
    }
    #[cfg(target_os = "windows")]
    {
        home.join("AppData")
            .join("Roaming")
            .join("MonoCode")
            .join("tasks")
            .join(format!("{label}.task.ps1"))
    }
    #[cfg(target_os = "linux")]
    {
        home.join(".config")
            .join("systemd")
            .join("user")
            .join(format!("{label}.service"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (home, label);
        PathBuf::new()
    }
}

#[cfg(test)]
pub fn watcher_interval_secs(platform: &str) -> u32 {
    if platform == "windows" {
        60
    } else {
        30
    }
}

#[cfg(any(test, target_os = "windows"))]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// One argument for `CommandLineToArgvW`. Backslashes before a quote are doubled,
/// which is the rule that keeps a path ending in `\` from eating the quote.
#[cfg(any(test, target_os = "windows"))]
fn win_quote(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0u32;
    for c in value.chars() {
        match c {
            '\\' => {
                slashes += 1;
                out.push('\\');
            }
            '"' => {
                for _ in 0..slashes + 1 {
                    out.push('\\');
                }
                out.push('"');
                slashes = 0;
            }
            other => {
                slashes = 0;
                out.push(other);
            }
        }
    }
    for _ in 0..slashes {
        out.push('\\');
    }
    out.push('"');
    out
}

#[cfg(any(test, target_os = "windows"))]
fn assert_task_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 160
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err("The task name has characters Task Scheduler must not see.".into())
    }
}

/// A per-user interactive task that runs `program autopilot-watch <data>` every minute.
/// Not a stored password. Removed again when autopilot turns off.
#[cfg(any(test, target_os = "windows"))]
pub fn watcher_task_script(
    program: &str,
    data_dir: &str,
    task_name: &str,
) -> Result<String, String> {
    assert_task_name(task_name)?;
    // PowerShell quoting is only the outer pair. Inside it, Windows quoting.
    let argument = format!("autopilot-watch {}", win_quote(data_dir));
    Ok(format!(
        r#"
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = {name}
if ($null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) {{
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}}
$action = New-ScheduledTaskAction -Execute {program} -Argument {argument}
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'MonoCode Hub autopilot relaunch' | Out-Null
"#,
        name = ps_quote(task_name),
        program = ps_quote(program),
        argument = ps_quote(&argument),
    ))
}

#[cfg(any(test, target_os = "windows"))]
pub fn watcher_task_remove_script(task_name: &str) -> Result<String, String> {
    assert_task_name(task_name)?;
    Ok(format!(
        r#"
$ErrorActionPreference = 'Stop'
$name = {name}
if ($null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) {{
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}}
"#,
        name = ps_quote(task_name),
    ))
}

#[cfg(any(test, target_os = "linux"))]
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
    )
}

#[cfg(any(test, target_os = "linux"))]
fn exec_quote(value: &str) -> String {
    unit_quote(&value.replace('$', "$$"))
}

/// A oneshot user service and a 30s timer. Linger is not turned on.
/// `OnActiveSec` fires the first run after the timer starts. `OnUnitActiveSec` is the
/// gap after each run, the same 30s as the Mac's LaunchAgent.
#[cfg(any(test, target_os = "linux"))]
pub fn watcher_systemd_units(program: &str, data_dir: &str) -> (String, String) {
    let exec = format!(
        "{} {} {}",
        exec_quote(program),
        exec_quote("autopilot-watch"),
        exec_quote(data_dir)
    );
    let service = format!(
        "[Unit]\nDescription=MonoCode Hub autopilot relaunch\n\n[Service]\nType=oneshot\nExecStart={exec}\nUMask=0077\n"
    );
    let timer = "\
[Unit]
Description=MonoCode Hub autopilot relaunch timer

[Timer]
OnActiveSec=30
OnUnitActiveSec=30
AccuracySec=5

[Install]
WantedBy=timers.target
"
    .to_string();
    (service, timer)
}

#[cfg(target_os = "windows")]
fn task_name(label: &str) -> String {
    let mut name: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    name.truncate(160);
    name
}

/// Install or remove the watcher. On macOS the LaunchAgent path does this; calling
/// this there is a no-op so a Mac build never registers a second mechanism.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn sync_watcher(
    label: &str,
    program: &Path,
    data_dir: &Path,
    file: &Path,
    installed: &mut bool,
    until: Option<i64>,
) {
    #[cfg(target_os = "macos")]
    {
        let _ = (label, program, data_dir, file, installed, until);
    }
    #[cfg(not(target_os = "macos"))]
    {
        match until {
            Some(_) => match install(label, program, data_dir, file) {
                Ok(()) => *installed = true,
                Err(error) => {
                    eprintln!("Autopilot: couldn't install the relaunch watcher: {error}")
                }
            },
            None if *installed || file.exists() => match remove(label, file) {
                Ok(()) => *installed = false,
                Err(error) => {
                    eprintln!("Autopilot: couldn't remove the relaunch watcher: {error}");
                    *installed = true;
                }
            },
            None => {}
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn install(label: &str, program: &Path, data_dir: &Path, file: &Path) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let script = watcher_task_script(
            &program.to_string_lossy(),
            &data_dir.to_string_lossy(),
            &task_name(label),
        )?;
        fs::write(file, &script).map_err(|error| error.to_string())?;
        run_powershell(&script)
    }
    #[cfg(target_os = "linux")]
    {
        let (service, timer) =
            watcher_systemd_units(&program.to_string_lossy(), &data_dir.to_string_lossy());
        fs::write(file, &service).map_err(|error| error.to_string())?;
        let timer_path = file.with_extension("timer");
        fs::write(&timer_path, timer).map_err(|error| error.to_string())?;
        let unit = file
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.ends_with(".service") && !name.contains(".."))
            .ok_or("The unit file has no name")?;
        let timer_name = format!("{}.timer", unit.trim_end_matches(".service"));
        systemctl(&["--user", "daemon-reload"])?;
        // The timer, not the oneshot service, is what repeats.
        systemctl(&["--user", "enable", "--now", &timer_name])?;
        let _ = systemctl(&["--user", "start", unit]);
        let _ = label;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (label, program, data_dir, file);
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn remove(label: &str, file: &Path) -> Result<(), String> {
    let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
        return Err("The watcher file has no name.".into());
    };
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("The watcher file is not inside its folder.".into());
    }
    #[cfg(target_os = "windows")]
    {
        let script = watcher_task_remove_script(&task_name(label))?;
        let _ = run_powershell(&script);
    }
    #[cfg(target_os = "linux")]
    {
        if name.ends_with(".service") && !name.contains("..") {
            let timer = format!("{}.timer", name.trim_end_matches(".service"));
            let _ = systemctl(&["--user", "disable", "--now", &timer]);
            let _ = systemctl(&["--user", "disable", "--now", name]);
        }
        let timer_path = file.with_extension("timer");
        if timer_path != file {
            let _ = fs::remove_file(&timer_path);
        }
        let _ = systemctl(&["--user", "daemon-reload"]);
        let _ = label;
    }
    let _ = fs::remove_file(file);
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<(), String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let bin = PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let wrapper = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); try { & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
    let encoded = utf16_base64(wrapper);
    let mut command = Command::new(bin);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    command.env_clear();
    for key in [
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
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                command.env(key, value);
            }
        }
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(script.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Task Scheduler didn't register the relaunch watcher.".into())
    }
}

#[cfg(target_os = "windows")]
fn utf16_base64(text: &str) -> String {
    let bytes: Vec<u8> = text
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(
        std::env::var("MONOCODE_SHIP_SYSTEMCTL").unwrap_or_else(|_| "systemctl".into()),
    );
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    command.env_clear();
    for key in [
        "PATH",
        "HOME",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "LANG",
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                command.env(key, value);
            }
        }
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("systemd didn't install the relaunch watcher.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_file, watcher_interval_secs, watcher_systemd_units, watcher_task_remove_script,
        watcher_task_script,
    };
    use std::path::Path;

    #[test]
    fn the_macos_watcher_file_stays_a_launch_agent() {
        let file = agent_file(
            Path::new("/Users/ada"),
            "com.ash.monocode-hub.autopilot-watch",
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            file,
            Path::new("/Users/ada/Library/LaunchAgents/com.ash.monocode-hub.autopilot-watch.plist")
        );
        #[cfg(target_os = "windows")]
        assert!(file.ends_with("com.ash.monocode-hub.autopilot-watch.task.ps1"));
        #[cfg(target_os = "linux")]
        assert!(file.ends_with("com.ash.monocode-hub.autopilot-watch.service"));
    }

    #[test]
    fn windows_repeats_every_minute_and_linux_every_30_seconds() {
        assert_eq!(watcher_interval_secs("windows"), 60);
        assert_eq!(watcher_interval_secs("linux"), 30);
        assert_eq!(watcher_interval_secs("macos"), 30);
        let script = watcher_task_script(
            "C:\\Program Files\\MonoCode Hub\\monocode.exe",
            "C:\\Users\\O'Brien\\AppData\\Roaming\\com.ash.monocode-hub",
            "com.ash.monocode-hub.autopilot-watch",
        )
        .unwrap();
        assert!(script.contains("LogonType Interactive"));
        assert!(script.contains("RepetitionInterval (New-TimeSpan -Minutes 1)"));
        assert!(script.contains("O''Brien"));
        assert!(!script.contains("AtLogOn"));
        assert!(watcher_task_script("p", "d", "bad name").is_err());
        let remove = watcher_task_remove_script("com.ash.monocode-hub.autopilot-watch").unwrap();
        assert!(remove.contains("Unregister-ScheduledTask"));
        assert!(!remove.contains("Register-ScheduledTask"));
        assert!(watcher_task_remove_script("bad name").is_err());
    }

    #[test]
    fn the_linux_timer_is_30_seconds_and_does_not_enable_linger() {
        let (service, timer) = watcher_systemd_units("/usr/bin/monocode", "/home/ada/data$");
        assert!(service.contains("Type=oneshot"));
        assert!(service.contains("autopilot-watch"));
        assert!(service.contains("data$$"));
        assert!(timer.contains("OnUnitActiveSec=30"));
        assert!(!timer.to_lowercase().contains("linger"));
        assert!(!service.to_lowercase().contains("linger"));
    }
}
