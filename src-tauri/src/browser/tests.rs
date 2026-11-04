use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Self {
        let n = SCRATCH.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hivra browser {} {} {}",
            std::process::id(),
            n,
            "文件夹"
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn data(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn settings_text(data: &Path) -> String {
    fs::read_to_string(browser_dir(data).join("settings.json")).unwrap_or_default()
}

fn row<'a>(profiles: &'a [Profile], id: &str) -> &'a Profile {
    profiles
        .iter()
        .find(|profile| profile.id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

#[test]
fn a_bad_id_is_refused_and_deletes_nothing() {
    let tmp = Tmp::new();
    let keep = tmp.data().join("keep");
    fs::write(&keep, "stay").unwrap();
    for id in [
        "",
        "..",
        "../keep",
        "a/b",
        r"a\b",
        ".hidden",
        &"a".repeat(121),
    ] {
        assert!(clear_profile(tmp.data(), id).is_err(), "{id}");
        assert!(set_watch(tmp.data(), id, true).is_err(), "{id}");
        assert!(keep.is_file());
    }
    assert!(list_profiles(tmp.data()).unwrap().is_empty());
}

#[test]
fn watch_and_a_chosen_folder_both_stick_and_a_broken_settings_file_is_replaced() {
    let tmp = Tmp::new();
    let folder = tmp.data().join("My folder");
    fs::create_dir_all(&folder).unwrap();
    fs::create_dir_all(browser_dir(tmp.data())).unwrap();
    fs::write(browser_dir(tmp.data()).join("settings.json"), "not json").unwrap();

    let data = tmp.data().to_path_buf();
    let chosen = folder.clone();
    let watch = std::thread::spawn(move || set_watch(&data, "ada", true));
    let data = tmp.data().to_path_buf();
    let own = std::thread::spawn(move || choose_own(&data, "ada", Some(chosen.to_str().unwrap())));
    assert!(watch.join().unwrap().is_ok());
    assert!(own.join().unwrap().is_ok());

    let profiles = list_profiles(tmp.data()).unwrap();
    let ada = row(&profiles, "ada");
    assert!(ada.watch);
    assert!(ada.own);
    assert_eq!(ada.path, path_text(&crate::fs::canonical(&folder).unwrap()));
    assert!(settings_text(tmp.data()).contains("\"watch\""));
}

#[test]
fn crlf_settings_still_parse_and_a_hand_edit_is_not_trusted() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", false).unwrap();
    let raw = "{\r\n  \"revision\": 4,\r\n  \"names\": { \"ada\": \"Ada\" },\r\n  \"watch\": { \"ada\": false },\r\n  \"own\": { \"ada\": \"/tmp/not-chosen\", \"milo\": { \"path\": \"relative/chrome\", \"chosen\": true }, \"nope\": { \"path\": \"/tmp/foo/../../etc\", \"chosen\": true } }\r\n}\r\n";
    fs::write(browser_dir(tmp.data()).join("settings.json"), raw).unwrap();
    let profiles = set_watch(tmp.data(), "ada", true).unwrap();
    let ada = row(&profiles, "ada");
    assert_eq!(ada.name, "Ada");
    assert!(ada.watch);
    assert!(!ada.own);
    assert!(list_profiles(tmp.data())
        .unwrap()
        .iter()
        .all(|profile| profile.id == "ada"));

    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    assert!(!plan.headless);
    assert!(!plan.own);
    assert_eq!(
        plan.profile,
        crate::fs::canonical(profiles_dir(tmp.data()).join("ada")).unwrap()
    );
}

#[test]
fn headless_unless_the_person_is_watching() {
    let tmp = Tmp::new();
    let hidden = launch_env(tmp.data(), "ada", "Ada").unwrap();
    assert!(hidden.headless);
    assert!(!hidden.visible);
    assert!(!hidden.own);
    set_watch(tmp.data(), "ada", true).unwrap();
    let shown = launch_env(tmp.data(), "ada", "Ada").unwrap();
    assert!(!shown.headless);
    assert!(shown.visible);
    assert_eq!(shown.name, "Ada");
}

#[test]
fn a_chosen_folder_is_used_and_clear_forgets_it_without_deleting_it() {
    let tmp = Tmp::new();
    let folder = tmp.data().join("Google").join("Chrome");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("secret"), "keep").unwrap();
    let profiles = choose_own(tmp.data(), "chat-1", Some(folder.to_str().unwrap())).unwrap();
    let row = row(&profiles, "chat-1");
    assert!(row.own);
    assert!(row.path.contains("Chrome"));

    let plan = launch_env(tmp.data(), "chat-1", "This chat").unwrap();
    assert!(plan.own);
    assert_eq!(plan.profile, crate::fs::canonical(&folder).unwrap());

    clear_profile(tmp.data(), "chat-1").unwrap();
    assert!(
        folder.join("secret").is_file(),
        "clear must not delete a folder the person chose"
    );
    assert!(list_profiles(tmp.data()).unwrap().is_empty());
}

#[test]
fn a_second_clear_removes_only_the_folder_this_app_made() {
    let tmp = Tmp::new();
    let folder = tmp.data().join("elsewhere");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("secret"), "keep").unwrap();
    set_watch(tmp.data(), "ada", true).unwrap();
    choose_own(tmp.data(), "ada", Some(folder.to_str().unwrap())).unwrap();
    let still = clear_profile(tmp.data(), "ada").unwrap();
    assert!(!row(&still, "ada").own);
    assert!(profiles_dir(tmp.data()).join("ada").is_dir());
    assert!(folder.join("secret").is_file());
    clear_profile(tmp.data(), "ada").unwrap();
    assert!(!profiles_dir(tmp.data()).join("ada").exists());
    assert!(folder.join("secret").is_file());
}

#[test]
fn clear_of_a_missing_profile_is_fine() {
    let tmp = Tmp::new();
    assert!(clear_profile(tmp.data(), "ada").unwrap().is_empty());
    assert!(clear_profile(tmp.data(), "ada").unwrap().is_empty());
}

#[test]
fn choose_own_refuses_a_broad_folder_and_a_missing_one() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let mut root = tmp.data().to_path_buf();
    while let Some(parent) = root.parent() {
        if parent.as_os_str().is_empty() || parent == root {
            break;
        }
        root = parent.to_path_buf();
    }
    assert!(choose_own(tmp.data(), "ada", Some(&path_text(&root))).is_err());
    if let Some(home) = dirs::home_dir() {
        assert!(choose_own(tmp.data(), "ada", Some(&path_text(&home)))
            .unwrap_err()
            .contains("home"));
    }
    assert!(choose_own(tmp.data(), "ada", Some(&path_text(tmp.data()))).is_err());
    assert!(choose_own(
        tmp.data(),
        "ada",
        Some(&path_text(&profiles_dir(tmp.data())))
    )
    .is_err());
    let inner = profiles_dir(tmp.data()).join("nested");
    fs::create_dir_all(&inner).unwrap();
    assert!(choose_own(tmp.data(), "ada", Some(&path_text(&inner))).is_err());
    assert!(choose_own(tmp.data(), "ada", Some("profiles/ada"))
        .unwrap_err()
        .contains("full path"));
    assert!(choose_own(
        tmp.data(),
        "ada",
        Some(&path_text(&tmp.data().join("missing")))
    )
    .unwrap_err()
    .contains("isn't there"));
    let file = tmp.data().join("a-file");
    fs::write(&file, "x").unwrap();
    assert!(choose_own(tmp.data(), "ada", Some(&path_text(&file))).is_err());
    assert!(row(&list_profiles(tmp.data()).unwrap(), "ada").watch);
    assert!(!row(&list_profiles(tmp.data()).unwrap(), "ada").own);
}

#[cfg(unix)]
#[test]
fn clear_unlinks_a_profile_symlink_and_leaves_the_target() {
    let tmp = Tmp::new();
    let outside = tmp.data().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret"), "keep").unwrap();
    fs::create_dir_all(profiles_dir(tmp.data())).unwrap();
    std::os::unix::fs::symlink(&outside, profiles_dir(tmp.data()).join("ada")).unwrap();
    clear_profile(tmp.data(), "ada").unwrap();
    assert!(outside.join("secret").is_file());
    assert!(!profiles_dir(tmp.data()).join("ada").exists());
}

#[test]
fn an_empty_choice_forgets_the_folder() {
    let tmp = Tmp::new();
    let folder = tmp.data().join("picked");
    fs::create_dir_all(&folder).unwrap();
    choose_own(tmp.data(), "ada", Some(folder.to_str().unwrap())).unwrap();
    let profiles = choose_own(tmp.data(), "ada", Some("  ")).unwrap();
    assert!(profiles.is_empty());
    assert!(folder.is_dir());
}

#[test]
fn profiles_sort_by_name_then_id() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "b", true).unwrap();
    set_watch(tmp.data(), "a", true).unwrap();
    with_settings(tmp.data(), |settings| {
        settings.names.insert("b".into(), "Ada".into());
        settings.names.insert("a".into(), "Ada".into());
        Ok(())
    })
    .unwrap();
    let ids: Vec<_> = list_profiles(tmp.data())
        .unwrap()
        .into_iter()
        .map(|profile| profile.id)
        .collect();
    assert_eq!(ids, ["a", "b"]);
}

#[test]
fn a_token_must_be_its_own_word() {
    assert!(token_in("sh -c loop hivra-abc", "hivra-abc"));
    assert!(!token_in("sh hivra-abc-extra", "hivra-abc"));
    assert!(!token_in("prefix-hivra-abc", "hivra-abc"));
    assert!(!token_in("hivra-abc", ""));
    assert!(!token_in("", "hivra-abc"));
}

#[test]
fn stopping_a_missing_drive_is_fine_and_a_low_pid_is_not_signalled() {
    let tmp = Tmp::new();
    assert!(stop(tmp.data(), "nope").is_err());
    let id = uuid::Uuid::new_v4().to_string();
    record_drive(
        tmp.data(),
        &StoredDrive {
            id: id.clone(),
            agent_id: "ada".into(),
            name: "Ada".into(),
            pid: 0,
            token: format!("hivra-{}", uuid::Uuid::new_v4()),
            visible: true,
            started_at_ms: 1,
            process_start: String::new(),
            done_path: String::new(),
        },
    )
    .unwrap();
    let error = stop(tmp.data(), &id).unwrap_err();
    assert!(error.contains("not stopped"));
    assert!(!drives_dir(tmp.data()).join(format!("{id}.json")).exists());
    assert!(stop(tmp.data(), &uuid::Uuid::new_v4().to_string()).is_ok());
}

#[test]
fn a_dead_pid_is_dropped_from_the_list() {
    let tmp = Tmp::new();
    let id = uuid::Uuid::new_v4().to_string();
    record_drive(
        tmp.data(),
        &StoredDrive {
            id: id.clone(),
            agent_id: "ada".into(),
            name: "Ada".into(),
            pid: u32::MAX,
            token: format!("hivra-{}", uuid::Uuid::new_v4()),
            visible: true,
            started_at_ms: 1,
            process_start: String::new(),
            done_path: String::new(),
        },
    )
    .unwrap();
    fs::write(drives_dir(tmp.data()).join("not-a-drive.json"), "nope").unwrap();
    assert!(visible_drives(tmp.data()).unwrap().is_empty());
    assert!(!drives_dir(tmp.data()).join(format!("{id}.json")).exists());
    assert!(!drives_dir(tmp.data()).join("not-a-drive.json").exists());
}

#[test]
fn stop_does_not_kill_a_process_whose_command_line_lacks_the_token() {
    let tmp = Tmp::new();
    let id = uuid::Uuid::new_v4().to_string();
    let token = format!("hivra-{}", uuid::Uuid::new_v4());
    record_drive(
        tmp.data(),
        &StoredDrive {
            id: id.clone(),
            agent_id: "ada".into(),
            name: "Ada".into(),
            pid: std::process::id(),
            token,
            visible: true,
            started_at_ms: 1,
            process_start: String::new(),
            done_path: String::new(),
        },
    )
    .unwrap();
    let error = stop(tmp.data(), &id).unwrap_err();
    assert!(error.contains("isn't this browser session"), "{error}");
    assert!(!drives_dir(tmp.data()).join(format!("{id}.json")).exists());
}

#[cfg(unix)]
#[test]
fn stop_ends_the_session_and_leaves_the_other_one() {
    let tmp = Tmp::new();
    let first = start_session(tmp.data(), "ada", "Ada", false).unwrap();
    let second = start_session(tmp.data(), "milo", "Milo", false).unwrap();
    assert!(
        visible_drives(tmp.data()).unwrap().is_empty(),
        "headless is not on the bar"
    );
    set_watch(tmp.data(), "ada", true).unwrap();
    let shown = start_session(tmp.data(), "ada", "Ada", false).unwrap();
    let names: Vec<_> = visible_drives(tmp.data())
        .unwrap()
        .into_iter()
        .map(|drive| drive.name)
        .collect();
    assert_eq!(names, ["Ada"]);
    let first_pid = first.child.id();
    stop(tmp.data(), &first.id).unwrap();
    assert!(!alive(first_pid));
    assert!(alive(second.child.id()));
    assert!(alive(shown.child.id()));
    stop_all(tmp.data()).unwrap();
    assert!(
        alive(second.child.id()),
        "Stop all leaves a session that is not on the bar"
    );
    assert!(!alive(shown.child.id()));
    assert!(visible_drives(tmp.data()).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_process_that_ignores_the_first_signal_is_not_a_final_failure() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let running = start_session(tmp.data(), "ada", "Ada", true).unwrap();
    let pid = running.child.id();
    assert!(stop(tmp.data(), &running.id).is_ok());
    assert!(!alive(pid));
}

#[cfg(unix)]
struct EndPid(u32);

#[cfg(unix)]
impl Drop for EndPid {
    fn drop(&mut self) {
        let Ok(pid) = i32::try_from(self.0) else {
            return;
        };
        if pid >= 2 {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
struct Reap(std::process::Child);

#[cfg(unix)]
impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn write_drive(data: &Path, id: &str, pid: u32, token: &str) {
    let dir = drives_dir(data);
    fs::create_dir_all(&dir).unwrap();
    let body = serde_json::json!({
        "id": id,
        "agent_id": "ada",
        "name": "Ada",
        "pid": pid,
        "token": token,
        "visible": true,
        "started_at_ms": 1
    });
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&body).unwrap(),
    )
    .unwrap();
}

#[test]
fn a_drive_file_whose_token_is_not_the_one_launch_mints_is_refused() {
    let tmp = Tmp::new();
    let error = record_drive(
        tmp.data(),
        &StoredDrive {
            id: uuid::Uuid::new_v4().to_string(),
            agent_id: "ada".into(),
            name: "Ada".into(),
            pid: 1,
            token: "node".into(),
            visible: true,
            started_at_ms: 1,
            process_start: String::new(),
            done_path: String::new(),
        },
    )
    .unwrap_err();
    assert!(error.contains("couldn't be recorded"), "{error}");
}

#[cfg(unix)]
#[test]
fn stop_does_not_signal_a_process_for_a_token_that_was_not_minted() {
    let tmp = Tmp::new();
    let mut command = std::process::Command::new("sleep");
    command.arg("30");
    allow_path(&mut command);
    let child = command.spawn().unwrap();
    let _reap = Reap(child);
    let pid = _reap.0.id();
    let id = uuid::Uuid::new_v4().to_string();
    write_drive(tmp.data(), &id, pid, "sleep");
    let _ = stop(tmp.data(), &id);
    assert!(alive(pid), "the word sleep is not a session token");
}

#[cfg(unix)]
#[test]
fn stop_does_not_signal_a_process_group_member_that_is_not_this_browser() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let running = start_session(tmp.data(), "ada", "Ada", false).unwrap();
    let mut extra = std::process::Command::new("sleep");
    extra.arg("30");
    allow_path(&mut extra);
    {
        use std::os::unix::process::CommandExt;
        extra.process_group(running.child.id() as i32);
    }
    let extra = extra.spawn().unwrap();
    let _reap = Reap(extra);
    let extra_pid = _reap.0.id();
    stop(tmp.data(), &running.id).unwrap();
    assert!(!alive(running.child.id()));
    assert!(
        alive(extra_pid),
        "a process in the group without this session's token stays"
    );
}

#[cfg(unix)]
#[test]
fn stop_does_not_signal_a_pid_whose_start_no_longer_matches() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let running = start_session(tmp.data(), "ada", "Ada", false).unwrap();
    let path = drives_dir(tmp.data()).join(format!("{}.json", running.id));
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    value["process_start"] = serde_json::json!("not-this-process");
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let error = stop(tmp.data(), &running.id).unwrap_err();
    assert!(
        alive(running.child.id()),
        "a reused pid is not this session: {error}"
    );
}

#[cfg(unix)]
#[test]
fn stop_ends_the_fake_server_and_leaves_the_other_process() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/browser/model/fakeEngine.mjs");
    let mut server = std::process::Command::new("node");
    server.arg(&fake).arg(&plan.token);
    server.stdout(std::process::Stdio::null());
    server.stderr(std::process::Stdio::null());
    allow_path(&mut server);
    // The fake engine exits when stdin closes. Hold the pipe so it stays this process.
    server.stdin(std::process::Stdio::piped());
    let mut server = server.spawn().unwrap();
    let held = server.stdin.take();
    let server_pid = server.id();
    let server = Reap(server);
    wait_until(
        || {
            command_line(server_pid)
                .ok()
                .is_some_and(|line| token_in(&line, &plan.token) && !defunct_line(&line))
        },
        "the fake server never showed its token",
    );
    let id = uuid::Uuid::new_v4().to_string();
    record_drive(
        tmp.data(),
        &StoredDrive {
            id: id.clone(),
            agent_id: "ada".into(),
            name: plan.name.clone(),
            pid: server_pid,
            token: plan.token.clone(),
            visible: true,
            started_at_ms: 1,
            process_start: process_start(server_pid).unwrap(),
            done_path: String::new(),
        },
    )
    .unwrap();

    let mut other = std::process::Command::new("sleep");
    other.arg("30");
    allow_path(&mut other);
    let other = other.spawn().unwrap();
    let _other = Reap(other);
    let other_pid = _other.0.id();

    stop(tmp.data(), &id).unwrap();
    assert!(!alive(server_pid), "Stop ends the fake server");
    assert!(alive(other_pid), "Stop leaves the other process");
    drop(held);
    drop(server);
}

#[cfg(unix)]
#[test]
fn the_recorded_pid_is_the_child_that_carries_the_token() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", true).unwrap();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/browser/model/fakeEngine.mjs");
    let mut command = std::process::Command::new("node");
    command.arg(&fake).arg(&plan.token);
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    allow_path(&mut command);
    command.stdin(std::process::Stdio::piped());
    let (mut child, path) = spawn_recorded(&mut command, tmp.data(), "ada", &plan).unwrap();
    let _held = child.stdin.take();
    wait_until(
        || {
            command_line(child.id())
                .ok()
                .is_some_and(|line| token_in(&line, &plan.token) && !defunct_line(&line))
        },
        "the recorded child never showed its token",
    );
    let drive = load_drive(&path).unwrap();
    assert_ne!(drive.pid, std::process::id());
    assert_eq!(drive.pid, child.id());
    let line = command_line(drive.pid).unwrap();
    assert!(token_in(&line, &plan.token), "{line}");
    assert!(!defunct_line(&line), "{line}");
    assert!(!drive.process_start.is_empty());
    assert_eq!(drive.process_start, process_start(drive.pid).unwrap());
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn wait_until(mut ready: impl FnMut() -> bool, why: &str) {
    let start = std::time::Instant::now();
    loop {
        if ready() {
            return;
        }
        if start.elapsed() > std::time::Duration::from_secs(3) {
            panic!("{why}");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn wait_pid_file(path: &Path) -> u32 {
    let start = std::time::Instant::now();
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(pid) = text.trim().parse::<u32>() {
                if alive(pid) {
                    return pid;
                }
            }
        }
        if start.elapsed() > std::time::Duration::from_secs(3) {
            panic!("the late child never wrote its pid");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn tree_lists_pid(path: &Path, pid: u32) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    value.as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row.get("pid").and_then(serde_json::Value::as_u64) == Some(u64::from(pid)))
    })
}

#[cfg(unix)]
#[test]
fn stop_waits_for_a_child_that_exits_late() {
    let tmp = Tmp::new();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let server = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/browser/server.mjs");
    let late = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/browser/model/lateChild.mjs");
    let pid_file = tmp.data().join("late.pid");
    let mut command = std::process::Command::new("node");
    command.arg(&server).arg(&plan.token);
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    allow_path(&mut command);
    command.stdin(std::process::Stdio::piped());
    command.env("HIVRA_BROWSER_PROFILE", &plan.profile);
    command.env("HIVRA_BROWSER_HEADLESS", "1");
    command.env("HIVRA_BROWSER_OWN_PROFILE", "0");
    command.env("HIVRA_BROWSER_SESSION", &plan.token);
    command.env("HIVRA_BROWSER_DONE", &plan.done);
    command.env("HIVRA_BROWSER_COMMAND", "node");
    command.env(
        "HIVRA_BROWSER_COMMAND_ARGS",
        serde_json::json!([late.to_string_lossy(), "late"]).to_string(),
    );
    command.env("HIVRA_LATE_PID", &pid_file);
    command.env("HIVRA_LATE_MS", "700");
    let (mut child, path) = spawn_recorded(&mut command, tmp.data(), "ada", &plan).unwrap();
    let drive = load_drive(&path).unwrap();
    let late_pid = wait_pid_file(&pid_file);
    let started = std::time::Instant::now();
    stop(tmp.data(), &drive.id).unwrap();
    assert!(
        !alive(late_pid),
        "Stop returns only after the child that exits late is gone"
    );
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(500),
        "Stop waited for the child instead of returning as soon as the wrapper exited"
    );
    assert!(!alive(child.id()));
    assert!(
        plan.done.is_file(),
        "the wrapper confirmed the tree was gone"
    );
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn a_defunct_process_is_already_gone() {
    let tmp = Tmp::new();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let mut command = std::process::Command::new("true");
    allow_path(&mut command);
    let mut child = command.spawn().unwrap();
    let pid = child.id();
    wait_until(|| is_zombie(pid), "true never became a zombie");
    let error = confirm_session(pid, &plan.token, "not-this-start").unwrap_err();
    assert_eq!(error, DEPARTED);
    let id = uuid::Uuid::new_v4().to_string();
    record_drive(
        tmp.data(),
        &StoredDrive {
            id: id.clone(),
            agent_id: "ada".into(),
            name: plan.name,
            pid,
            token: plan.token,
            visible: true,
            started_at_ms: 1,
            process_start: "not-this-start".into(),
            done_path: String::new(),
        },
    )
    .unwrap();
    stop(tmp.data(), &id).unwrap();
    assert!(!drives_dir(tmp.data()).join(format!("{id}.json")).exists());
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn stop_does_not_succeed_when_the_browser_tree_was_not_confirmed() {
    let tmp = Tmp::new();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let server = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/browser/server.mjs");
    let late = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/browser/model/lateChild.mjs");
    let pid_file = tmp.data().join("hold.pid");
    let mut command = std::process::Command::new("node");
    command.arg(&server).arg(&plan.token);
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    allow_path(&mut command);
    command.stdin(std::process::Stdio::piped());
    command.env("HIVRA_BROWSER_PROFILE", &plan.profile);
    command.env("HIVRA_BROWSER_HEADLESS", "1");
    command.env("HIVRA_BROWSER_OWN_PROFILE", "0");
    command.env("HIVRA_BROWSER_SESSION", &plan.token);
    command.env("HIVRA_BROWSER_DONE", &plan.done);
    command.env("HIVRA_BROWSER_COMMAND", "node");
    command.env(
        "HIVRA_BROWSER_COMMAND_ARGS",
        serde_json::json!([late.to_string_lossy(), "hold"]).to_string(),
    );
    command.env("HIVRA_LATE_PID", &pid_file);
    let (mut child, path) = spawn_recorded(&mut command, tmp.data(), "ada", &plan).unwrap();
    let drive = load_drive(&path).unwrap();
    let hold_pid = wait_pid_file(&pid_file);
    let _end_hold = EndPid(hold_pid);
    // SIGKILL skips the wrapper's shutdown, so it never confirms the tree.
    child.kill().unwrap();
    wait_until(
        || !alive(child.id()),
        "the wrapper was still running after it was killed",
    );
    let tree = drives_dir(tmp.data()).join(format!("{}.tree", plan.token));
    let _ = fs::remove_file(&tree);
    let _ = visible_drives(tmp.data()).unwrap();
    assert!(path.is_file(), "a missing done file keeps the drive");
    let error = stop(tmp.data(), &drive.id).unwrap_err();
    assert!(error.contains("not stopped"), "{error}");
    assert!(alive(hold_pid), "the browser was not confirmed gone");
    assert!(!plan.done.is_file());
    assert!(path.is_file(), "Stop keeps a browser it could not confirm");
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn stop_follows_the_recorded_tree_when_the_wrapper_died_without_confirming() {
    let tmp = Tmp::new();
    let plan = launch_env(tmp.data(), "ada", "Ada").unwrap();
    let server = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/browser/server.mjs");
    let late = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/browser/model/lateChild.mjs");
    let pid_file = tmp.data().join("hold.pid");
    let mut command = std::process::Command::new("node");
    command.arg(&server).arg(&plan.token);
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    allow_path(&mut command);
    command.stdin(std::process::Stdio::piped());
    command.env("HIVRA_BROWSER_PROFILE", &plan.profile);
    command.env("HIVRA_BROWSER_HEADLESS", "1");
    command.env("HIVRA_BROWSER_OWN_PROFILE", "0");
    command.env("HIVRA_BROWSER_SESSION", &plan.token);
    command.env("HIVRA_BROWSER_DONE", &plan.done);
    command.env("HIVRA_BROWSER_COMMAND", "node");
    command.env(
        "HIVRA_BROWSER_COMMAND_ARGS",
        serde_json::json!([late.to_string_lossy(), "hold"]).to_string(),
    );
    command.env("HIVRA_LATE_PID", &pid_file);
    let (mut child, path) = spawn_recorded(&mut command, tmp.data(), "ada", &plan).unwrap();
    let drive = load_drive(&path).unwrap();
    let hold_pid = wait_pid_file(&pid_file);
    let _end_hold = EndPid(hold_pid);
    let tree = drives_dir(tmp.data()).join(format!("{}.tree", plan.token));
    wait_until(
        || tree_lists_pid(&tree, hold_pid),
        "the wrapper never recorded the browser",
    );
    child.kill().unwrap();
    wait_until(
        || !alive(child.id()),
        "the wrapper was still running after it was killed",
    );
    let _ = visible_drives(tmp.data()).unwrap();
    assert!(
        path.is_file(),
        "a drive stays while its done file is missing"
    );
    stop(tmp.data(), &drive.id).unwrap();
    assert!(!alive(hold_pid), "Stop ends the recorded browser");
    assert!(
        !path.is_file(),
        "the drive goes only after that browser is gone"
    );
    let _ = child.wait();
}

#[cfg(unix)]
#[test]
fn stop_all_stops_only_the_sessions_the_bar_shows() {
    let tmp = Tmp::new();
    let hidden = start_session(tmp.data(), "milo", "Milo", false).unwrap();
    set_watch(tmp.data(), "ada", true).unwrap();
    let shown = start_session(tmp.data(), "ada", "Ada", false).unwrap();
    assert_eq!(visible_drives(tmp.data()).unwrap().len(), 1);
    stop_all(tmp.data()).unwrap();
    assert!(!alive(shown.child.id()), "the session on the bar stops");
    assert!(
        alive(hidden.child.id()),
        "a hidden session is not on the bar, so Stop all leaves it"
    );
}

#[cfg(unix)]
#[test]
fn an_empty_lock_start_does_not_match_a_reused_pid() {
    let tmp = Tmp::new();
    let dir = browser_dir(tmp.data());
    fs::create_dir_all(&dir).unwrap();
    let mut sleeper = std::process::Command::new("sleep");
    sleeper.arg("30");
    allow_path(&mut sleeper);
    let sleeper = sleeper.spawn().unwrap();
    let sleeper = Reap(sleeper);
    let pid = sleeper.0.id();
    let path = dir.join("settings.lock");
    let body = serde_json::json!({
        "nonce": "dead-holder",
        "pid": pid,
        "started": ""
    });
    fs::write(&path, body.to_string()).unwrap();
    let started = std::time::Instant::now();
    let taken = lock_settings(&dir);
    assert!(
        started.elapsed() < std::time::Duration::from_millis(800),
        "an empty start time must not be waited out as if it were the holder"
    );
    let lock = taken.expect("a crashed lock with no start time can be taken");
    let owner: LockOwner = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(!owner.started.is_empty(), "the new lock has a start time");
    assert_ne!(owner.nonce, "dead-holder");
    assert_ne!(owner.pid, pid);
    assert!(
        alive(pid),
        "the sleeper is a different process and stays up"
    );
    drop(lock);
}

#[test]
fn a_holder_does_not_delete_a_lock_it_no_longer_owns() {
    let tmp = Tmp::new();
    let dir = browser_dir(tmp.data());
    let lock = lock_settings(&dir).unwrap();
    let path = dir.join("settings.lock");
    fs::write(&path, "kept-by-the-new-holder").unwrap();
    drop(lock);
    assert!(path.is_file(), "the new holder's lock is still there");
    assert_eq!(fs::read_to_string(&path).unwrap(), "kept-by-the-new-holder");
}

#[test]
fn a_live_holders_lock_is_not_taken_because_it_is_old() {
    let tmp = Tmp::new();
    let dir = browser_dir(tmp.data());
    let lock = lock_settings(&dir).unwrap();
    let path = dir.join("settings.lock");
    let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(90))
        .unwrap();
    drop(file);
    let taken = lock_settings(&dir);
    assert!(
        taken.is_err(),
        "a live holder keeps the lock past 30 seconds"
    );
    assert!(path.is_file());
    drop(lock);
}

#[test]
fn a_stale_revision_is_not_written_over_a_newer_one() {
    let tmp = Tmp::new();
    set_watch(tmp.data(), "ada", false).unwrap();
    let path = browser_dir(tmp.data()).join("settings.json");
    BEFORE_SETTINGS_WRITE.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |file: &Path| {
            let mut settings = read_settings(file);
            settings.revision = 9;
            settings.names.insert("ada".into(), "kept".into());
            write_settings(file, &settings).unwrap();
        }));
    });
    let saved = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set_watch(tmp.data(), "ada", true).unwrap();
    }));
    BEFORE_SETTINGS_WRITE.with(|hook| *hook.borrow_mut() = None);
    saved.unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("kept"), "{text}");
    assert!(text.contains("\"watch\""), "{text}");
    let settings = read_settings(&path);
    assert!(settings.watch.get("ada").copied().unwrap_or(false));
    assert_eq!(settings.names.get("ada").map(String::as_str), Some("kept"));
    assert!(settings.revision > 9, "{}", settings.revision);
}

#[test]
fn wiring_passes_the_agent_and_leaves_the_browser_out_without_one() {
    let tmp = Tmp::new();
    let plugins = tmp.data().join("plugins");
    fs::create_dir_all(&plugins).unwrap();
    let host = crate::plugins::registry::Host {
        root: plugins.clone(),
        agents_skills: tmp.data().join("skills"),
    };
    let plugin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/browser");
    crate::plugins::registry::install_local(
        &host,
        &plugin,
        crate::plugins::registry::Source::local(&plugin),
    )
    .unwrap();
    crate::plugins::registry::enable(&host, "browser", &crate::plugins::registry::Scope::Global)
        .unwrap();

    let agent = crate::plugins::wiring::SessionAgent {
        id: "mono-ada",
        name: "Ada Lovelace",
    };
    let wired = crate::plugins::wiring::session_wiring_for(
        &host,
        None,
        Some("monocode"),
        &BTreeSet::new(),
        Some(&agent),
    )
    .unwrap();
    for servers in [&wired.claude_mcp_servers, &wired.codex_mcp_servers] {
        let args = servers.get("plugin-browser-browser").unwrap()["args"]
            .as_array()
            .unwrap();
        let text: Vec<_> = args.iter().map(|value| value.as_str().unwrap()).collect();
        assert!(
            text.windows(2).any(|pair| pair == ["--agent", "mono-ada"]),
            "{text:?}"
        );
        assert!(
            text.windows(2)
                .any(|pair| pair == ["--agent-name", "Ada Lovelace"]),
            "{text:?}"
        );
    }

    let bare =
        crate::plugins::wiring::session_wiring(&host, None, Some("monocode"), &BTreeSet::new())
            .unwrap();
    assert!(!bare
        .claude_mcp_servers
        .contains_key("plugin-browser-browser"));
    assert!(bare
        .reports
        .iter()
        .any(|report| report.message.contains("no agent")));

    let empty = crate::plugins::registry::Host {
        root: tmp.data().join("empty-plugins"),
        agents_skills: tmp.data().join("skills"),
    };
    let with_agent = crate::plugins::wiring::prepare_launch(&[
        "--root".into(),
        path_text(&empty.root),
        "--plugin".into(),
        "browser".into(),
        "--server".into(),
        "browser".into(),
        "--agent".into(),
        "--weird".into(),
        "--agent-name".into(),
        "Ada".into(),
    ])
    .unwrap_err();
    assert!(!with_agent.contains("unknown option"), "{with_agent}");
    assert!(with_agent.contains("isn't installed"), "{with_agent}");

    let unknown = crate::plugins::wiring::prepare_launch(&[
        "--root".into(),
        path_text(&empty.root),
        "--plugin".into(),
        "browser".into(),
        "--server".into(),
        "browser".into(),
        "--nope".into(),
        "x".into(),
    ])
    .unwrap_err();
    assert!(unknown.contains("unknown option"), "{unknown}");

    let keep = tmp.data().join("keep");
    fs::write(&keep, "stay").unwrap();
    let code = run(&[
        "--root".into(),
        path_text(&plugins),
        "--agents-skills".into(),
        path_text(&host.agents_skills),
        "--plugin".into(),
        "browser".into(),
        "--server".into(),
        "browser".into(),
        "--agent".into(),
        "../keep".into(),
    ]);
    assert_eq!(code, 78);
    assert_eq!(fs::read_to_string(keep).unwrap(), "stay");
}
