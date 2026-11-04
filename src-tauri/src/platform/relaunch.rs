// WP-09: relaunch the app after a crash.
// macOS keeps its LaunchAgent (autopilot.rs `install_agent`). Windows uses Task Scheduler
// and Linux a systemd user timer. The watcher interval stays 30s, except Windows, where
// Task Scheduler's shortest repetition is one minute.

#[cfg(any(test, not(target_os = "macos")))]
use std::cell::RefCell;
#[cfg(any(test, not(target_os = "macos")))]
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

/// What a test uses instead of Task Scheduler or systemd. Production leaves this unset.
/// A thread-local, not an environment variable: the test runner shares a process.
#[cfg(any(test, not(target_os = "macos")))]
struct WatcherControl {
    loaded: bool,
    unregister_error: Option<String>,
    registers: u32,
}

#[cfg(any(test, not(target_os = "macos")))]
thread_local! {
    static WATCHER_CONTROL: RefCell<Option<WatcherControl>> = const { RefCell::new(None) };
}

#[cfg(test)]
struct WatcherGuard;

#[cfg(test)]
impl Drop for WatcherGuard {
    fn drop(&mut self) {
        WATCHER_CONTROL.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(test)]
fn set_watcher(control: WatcherControl) -> WatcherGuard {
    WATCHER_CONTROL.with(|slot| *slot.borrow_mut() = Some(control));
    WatcherGuard
}

#[cfg(any(test, not(target_os = "macos")))]
fn seam_loaded() -> Option<bool> {
    WATCHER_CONTROL.with(|slot| slot.borrow().as_ref().map(|control| control.loaded))
}

/// A missing unit is already gone. Anything else (a busy unit, no permission) is a real failure,
/// and the watcher file stays so the next sync can try again.
#[cfg(any(test, target_os = "linux"))]
fn unit_is_gone(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("does not exist") || lower.contains("not found") || lower.contains("not loaded")
}

#[cfg(any(test, not(target_os = "macos")))]
fn watch_file(data_dir: &Path) -> PathBuf {
    data_dir.join("autopilot").join("watch.json")
}

/// The same file macOS writes (`untilMs`, `label`, `domain`, `plist`). Rewritten on every
/// install because the end time moves even when the task or unit does not.
#[cfg(any(test, not(target_os = "macos")))]
fn write_watch(
    data_dir: &Path,
    label: &str,
    domain: &str,
    plist: &Path,
    until_ms: i64,
) -> Result<(), String> {
    let dir = data_dir.join("autopilot");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = watch_file(data_dir);
    let value = crate::autopilot::WatchFile {
        until_ms,
        label: label.to_string(),
        domain: domain.to_string(),
        plist: plist.to_path_buf(),
    };
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

#[cfg(any(test, not(target_os = "macos")))]
fn watcher_text(program: &Path, data_dir: &Path, label: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return watcher_task_script(
            &program.to_string_lossy(),
            &data_dir.to_string_lossy(),
            &task_name(label),
        );
    }
    #[cfg(target_os = "linux")]
    {
        let _ = label;
        return Ok(
            watcher_systemd_units(&program.to_string_lossy(), &data_dir.to_string_lossy()).0,
        );
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(format!(
            "watcher\n{}\n{}\n{label}\n",
            program.display(),
            data_dir.display()
        ))
    }
}

#[cfg(any(test, not(target_os = "macos")))]
fn watcher_is_loaded(label: &str, file: &Path) -> bool {
    if let Some(loaded) = seam_loaded() {
        return loaded;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = file;
        return task_loaded(&task_name(label));
    }
    #[cfg(target_os = "linux")]
    {
        let _ = label;
        return unit_loaded(file);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (label, file);
        false
    }
}

#[cfg(target_os = "windows")]
fn task_loaded(name: &str) -> bool {
    let Ok(script) = watcher_task_loaded_script(name) else {
        return false;
    };
    run_powershell(&script).is_ok()
}

#[cfg(target_os = "windows")]
fn watcher_task_loaded_script(task_name: &str) -> Result<String, String> {
    assert_task_name(task_name)?;
    Ok(format!(
        r#"
$ErrorActionPreference = 'Stop'
$name = {name}
if ($null -eq (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) {{ exit 1 }}
"#,
        name = ps_quote(task_name),
    ))
}

#[cfg(target_os = "linux")]
fn unit_loaded(file: &Path) -> bool {
    let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !name.ends_with(".service") || name.contains("..") {
        return false;
    }
    let timer = format!("{}.timer", name.trim_end_matches(".service"));
    systemctl(&["--user", "is-enabled", &timer]).is_ok()
}

#[cfg(any(test, not(target_os = "macos")))]
fn register_watcher(label: &str, file: &Path, text: &str) -> Result<(), String> {
    let steered = WATCHER_CONTROL.with(|slot| {
        let mut borrowed = slot.borrow_mut();
        let control = borrowed.as_mut()?;
        control.registers += 1;
        control.loaded = true;
        Some(Ok(()))
    });
    if let Some(result) = steered {
        return result;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (label, file);
        return run_powershell(text);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (label, text);
        return enable_timer(file);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (label, file, text);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn enable_timer(file: &Path) -> Result<(), String> {
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
    Ok(())
}

#[cfg(any(test, not(target_os = "macos")))]
fn unregister_watcher(label: &str, file: &Path) -> Result<(), String> {
    let steered = WATCHER_CONTROL.with(|slot| {
        let mut borrowed = slot.borrow_mut();
        let control = borrowed.as_mut()?;
        if let Some(error) = control.unregister_error.clone() {
            return Some(Err(error));
        }
        control.loaded = false;
        Some(Ok(()))
    });
    if let Some(result) = steered {
        return result;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = file;
        let script = watcher_task_remove_script(&task_name(label))?;
        return run_powershell(&script);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = label;
        return disable_units(file);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (label, file);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn disable_units(file: &Path) -> Result<(), String> {
    let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
        return Err("The watcher file has no name.".into());
    };
    if name.ends_with(".service") && !name.contains("..") {
        let timer = format!("{}.timer", name.trim_end_matches(".service"));
        disable_one(&timer)?;
        disable_one(name)?;
    }
    let _ = systemctl(&["--user", "daemon-reload"]);
    Ok(())
}

#[cfg(target_os = "linux")]
fn disable_one(name: &str) -> Result<(), String> {
    match systemctl(&["--user", "disable", "--now", name]) {
        Ok(()) => Ok(()),
        Err(error) if unit_is_gone(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(any(test, not(target_os = "macos")))]
fn delete_watcher_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Install or remove the watcher. On macOS the LaunchAgent path does this; calling
/// this there is a no-op so a Mac build never registers a second mechanism.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn sync_watcher(
    label: &str,
    program: &Path,
    data_dir: &Path,
    file: &Path,
    domain: &str,
    installed: &mut bool,
    until: Option<i64>,
) {
    #[cfg(target_os = "macos")]
    {
        let _ = (label, program, data_dir, file, domain, installed, until);
    }
    #[cfg(not(target_os = "macos"))]
    {
        match until {
            Some(until) => match install(label, program, data_dir, file, domain, until) {
                Ok(()) => *installed = true,
                Err(error) => {
                    eprintln!("Autopilot: couldn't install the relaunch watcher: {error}")
                }
            },
            None if *installed || file.exists() => match remove(label, file, data_dir) {
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

#[cfg(any(test, not(target_os = "macos")))]
fn install(
    label: &str,
    program: &Path,
    data_dir: &Path,
    file: &Path,
    domain: &str,
    until_ms: i64,
) -> Result<(), String> {
    write_watch(data_dir, label, domain, file, until_ms)?;
    let text = watcher_text(program, data_dir, label)?;
    let current = fs::read_to_string(file).ok();
    // Same words and already registered: only the end time moved. Registering again
    // fails once the task or unit is there, the same as bootstrapping a loaded label.
    if current.as_deref() == Some(text.as_str()) && watcher_is_loaded(label, file) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(file, &text).map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    {
        let timer_path = file.with_extension("timer");
        let timer =
            watcher_systemd_units(&program.to_string_lossy(), &data_dir.to_string_lossy()).1;
        fs::write(&timer_path, timer).map_err(|error| error.to_string())?;
    }
    register_watcher(label, file, &text)
}

/// Take the watcher away. A failed unregister keeps the file and `watch.json`, and the
/// error comes back so the next sync tries again.
#[cfg(any(test, not(target_os = "macos")))]
pub fn remove(label: &str, file: &Path, data_dir: &Path) -> Result<(), String> {
    let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
        return Err("The watcher file has no name.".into());
    };
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("The watcher file is not inside its folder.".into());
    }
    unregister_watcher(label, file)?;
    #[cfg(target_os = "linux")]
    {
        let timer_path = file.with_extension("timer");
        if timer_path != file {
            delete_watcher_file(&timer_path)?;
        }
    }
    delete_watcher_file(file)?;
    delete_watcher_file(&watch_file(data_dir))?;
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
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        if detail.is_empty() {
            Err("systemd didn't install the relaunch watcher.".into())
        } else {
            Err(detail.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_file, set_watcher, watcher_interval_secs, watcher_systemd_units,
        watcher_task_remove_script, watcher_task_script, WATCHER_CONTROL,
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

    #[test]
    fn a_missing_systemd_unit_counts_as_already_removed() {
        assert!(super::unit_is_gone(
            "Failed to disable unit: Unit monocode.timer does not exist."
        ));
        assert!(super::unit_is_gone("Unit monocode.service not found."));
        assert!(super::unit_is_gone("Unit monocode.timer is not loaded."));
        assert!(!super::unit_is_gone("access denied"));
        assert!(!super::unit_is_gone(""));
    }

    #[test]
    fn install_writes_watch_json_and_skips_a_second_register_when_nothing_changed() {
        let root =
            std::env::temp_dir().join(format!("wp09-watch-{}-{}", std::process::id(), "install"));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data");
        let file = root.join("watcher.task");
        let program = root.join("monocode");
        let _guard = set_watcher(super::WatcherControl {
            loaded: false,
            unregister_error: None,
            registers: 0,
        });
        super::install(
            "com.ash.monocode-hub.autopilot-watch",
            &program,
            &data,
            &file,
            "gui/501",
            10,
        )
        .unwrap();
        let watch: crate::autopilot::WatchFile =
            serde_json::from_slice(&std::fs::read(data.join("autopilot/watch.json")).unwrap())
                .unwrap();
        assert_eq!(watch.until_ms, 10);
        assert_eq!(watch.label, "com.ash.monocode-hub.autopilot-watch");
        assert_eq!(watch.domain, "gui/501");
        assert_eq!(watch.plist, file);
        assert!(file.is_file());
        WATCHER_CONTROL.with(|slot| slot.borrow_mut().as_mut().unwrap().loaded = true);
        super::install(
            "com.ash.monocode-hub.autopilot-watch",
            &program,
            &data,
            &file,
            "gui/501",
            20,
        )
        .unwrap();
        let again: crate::autopilot::WatchFile =
            serde_json::from_slice(&std::fs::read(data.join("autopilot/watch.json")).unwrap())
                .unwrap();
        assert_eq!(again.until_ms, 20, "the end time still moves");
        let registers = WATCHER_CONTROL.with(|slot| slot.borrow().as_ref().unwrap().registers);
        assert_eq!(
            registers, 1,
            "an unchanged loaded watcher is not registered again"
        );
        WATCHER_CONTROL.with(|slot| slot.borrow_mut().as_mut().unwrap().loaded = false);
        super::install(
            "com.ash.monocode-hub.autopilot-watch",
            &program,
            &data,
            &file,
            "gui/501",
            20,
        )
        .unwrap();
        let registers = WATCHER_CONTROL.with(|slot| slot.borrow().as_ref().unwrap().registers);
        assert_eq!(
            registers, 2,
            "a watcher that is not loaded is registered again"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_unregister_keeps_the_watcher_and_watch_json() {
        let root =
            std::env::temp_dir().join(format!("wp09-watch-{}-{}", std::process::id(), "remove"));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data");
        let file = root.join("watcher.task");
        let program = root.join("monocode");
        let _guard = set_watcher(super::WatcherControl {
            loaded: false,
            unregister_error: Some("Task Scheduler refused.".into()),
            registers: 0,
        });
        super::install("label", &program, &data, &file, "", 5).unwrap();
        let error = super::remove("label", &file, &data).unwrap_err();
        assert!(error.contains("refused"));
        assert!(
            file.is_file(),
            "the watcher file stays when unregister fails"
        );
        assert!(
            data.join("autopilot/watch.json").is_file(),
            "watch.json stays when unregister fails"
        );
        WATCHER_CONTROL.with(|slot| {
            slot.borrow_mut().as_mut().unwrap().unregister_error = None;
        });
        super::remove("label", &file, &data).unwrap();
        assert!(!file.exists());
        assert!(!data.join("autopilot/watch.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
