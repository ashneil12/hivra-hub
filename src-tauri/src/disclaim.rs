//! Harness CLIs start as their own "responsible process" on macOS (r53).
//!
//! macOS charges a child's privacy (TCC) requests to the app that started it, so a Claude Code session the Hub
//! starts makes the system ask "MonoCode Hub.app would like to access data from other apps". To avoid that, the
//! Hub starts `monocode disclaim-exec -- <program> <args…>` in place of `<program>`. Pipes, working directory,
//! environment and process group are already set on that child. The launcher calls `posix_spawn` with
//! `POSIX_SPAWN_SETEXEC` and `responsibility_spawnattrs_setdisclaim`, which turns the launcher itself into the CLI:
//! the pid, open files, cwd and process group stay the same, so reading the pipes and stopping the pid or its group
//! work exactly as before. Claude Desktop does the same thing with its `disclaimer` helper.
//!
//! The switch is on by default on macOS and has no effect elsewhere. To turn it off, write `off` to
//! `<app data>/settings/disclaim-harness` or set `MONOCODE_DISCLAIM_HARNESS=0`. Each new session reads the switch.
//! There are two fallbacks. When the launcher can't be used (the switch is off, the CLI isn't found, or this
//! binary's path is unknown), the Hub spawns the CLI directly, as it did before r53. When the disclaimed spawn
//! fails inside the launcher, the launcher prints a `[disclaim]` line on stderr and execs the CLI normally (same
//! pid, not disclaimed).
//!
//! `monocode disclaim-exec --responsible <pid>` prints the pid macOS holds responsible for `<pid>`. For a
//! disclaimed CLI it prints the CLI's own pid; for a plain child it prints the Hub's pid.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SUBCOMMAND: &str = "disclaim-exec";
pub const ENV_SWITCH: &str = "MONOCODE_DISCLAIM_HARNESS";
pub const SETTING_FILE: &str = "disclaim-harness";

fn off_word(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "off" | "false" | "no"
    )
}

/// Off when the environment switch or the setting file says off. The environment wins either way.
pub(crate) fn switched_off(env: Option<&OsStr>, file: Option<&str>) -> bool {
    if let Some(env) = env.and_then(OsStr::to_str) {
        return off_word(env);
    }
    file.is_some_and(off_word)
}

/// Whether new harness sessions start disclaimed: macOS only, unless switched off.
pub(crate) fn enabled(data_dir: Option<&Path>) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let env = std::env::var_os(ENV_SWITCH);
    let file = data_dir
        .and_then(|dir| std::fs::read_to_string(dir.join("settings").join(SETTING_FILE)).ok());
    !switched_off(env.as_deref(), file.as_deref())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// `program` as a path the launcher can start: itself if it names a path, else the first match on `path_var`.
pub(crate) fn resolve(program: &OsStr, path_var: Option<&OsStr>) -> Option<PathBuf> {
    let as_path = Path::new(program);
    if as_path.components().count() > 1 || as_path.is_absolute() {
        return is_executable(as_path).then(|| as_path.to_path_buf());
    }
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable(candidate))
}

/// The launcher for `program`, if this session should start disclaimed. A CLI that can't be found gets no launcher,
/// so it fails at spawn with its own error, as before.
pub(crate) fn launcher_for(program: &OsStr, data_dir: Option<&Path>) -> Option<PathBuf> {
    if !enabled(data_dir) {
        return None;
    }
    resolve(program, std::env::var_os("PATH").as_deref())?;
    let exe = std::env::current_exe().ok()?;
    is_executable(&exe).then_some(exe)
}

/// A Command that starts `program` either directly or through `launcher`. Arguments, environment, working
/// directory, stdio and process group added later apply the same way in both cases.
///
/// `argv0` is the name the child should see when it differs from `program` (a same-folder multi-call link).
/// Through the launcher that is `--argv0 <name> -- <program>`. A direct start sets it on the command.
pub(crate) fn command(program: &OsStr, launcher: Option<&Path>, argv0: Option<&OsStr>) -> Command {
    match launcher {
        Some(launcher) => {
            let mut cmd = Command::new(launcher);
            cmd.arg(SUBCOMMAND);
            if let Some(name) = argv0 {
                cmd.arg("--argv0").arg(name);
            }
            cmd.arg("--").arg(program);
            cmd
        }
        None => {
            let mut cmd = Command::new(program);
            #[cfg(unix)]
            if let Some(name) = argv0 {
                use std::os::unix::process::CommandExt;
                cmd.arg0(name);
            }
            #[cfg(not(unix))]
            let _ = argv0;
            cmd
        }
    }
}

enum Request {
    /// `file` is executed. `argv` is what the child sees, and `argv[0]` may differ from `file`.
    Exec {
        file: OsString,
        argv: Vec<OsString>,
    },
    Responsible(i32),
}

fn parse(args: &[OsString]) -> Result<Request, String> {
    let usage = "usage: monocode disclaim-exec -- <program> [args…]";
    match args.first().and_then(|a| a.to_str()) {
        Some("--responsible") => args
            .get(1)
            .and_then(|a| a.to_str())
            .and_then(|a| a.parse::<i32>().ok())
            .filter(|pid| *pid > 0)
            .map(Request::Responsible)
            .ok_or_else(|| "usage: monocode disclaim-exec --responsible <pid>".to_string()),
        Some("--argv0") => {
            let Some(name) = args.get(1).cloned() else {
                return Err(usage.into());
            };
            if args.get(2).and_then(|a| a.to_str()) != Some("--") || args.len() < 4 {
                return Err(usage.into());
            }
            let file = args[3].clone();
            let mut argv = Vec::with_capacity(args.len() - 3);
            argv.push(name);
            argv.extend_from_slice(&args[4..]);
            Ok(Request::Exec { file, argv })
        }
        Some("--") if args.len() > 1 => Ok(Request::Exec {
            file: args[1].clone(),
            argv: args[1..].to_vec(),
        }),
        _ => Err(usage.into()),
    }
}

/// `monocode disclaim-exec …` (main.rs). On success the exec branch never returns.
pub fn main(args: &[OsString]) -> i32 {
    match parse(args) {
        Err(usage) => {
            eprintln!("{usage}");
            2
        }
        Ok(Request::Responsible(pid)) => match responsible_pid(pid) {
            Some(responsible) => {
                println!("{responsible}");
                0
            }
            None => {
                eprintln!("no responsible pid for {pid}");
                1
            }
        },
        Ok(Request::Exec { file, argv }) => {
            match disclaimed_exec(&file, &argv) {
                Ok(never) => match never {},
                Err(why) => eprintln!("[disclaim] {why}; starting it without disclaim"),
            }
            plain_exec(&file, &argv)
        }
    }
}

#[cfg(unix)]
fn plain_exec(file: &OsStr, argv: &[OsString]) -> i32 {
    use std::os::unix::process::CommandExt;
    // std's exec resets SIGPIPE and the signal mask, as std's spawn does for a plain child.
    // argv[0] is the name the child sees. It is the file itself when no other name was asked for.
    let shown = argv.first().map(OsString::as_os_str).unwrap_or(file);
    let err = Command::new(file)
        .arg0(shown)
        .args(argv.get(1..).unwrap_or(&[]))
        .exec();
    eprintln!("Failed to start {}: {err}", file.to_string_lossy());
    if err.kind() == std::io::ErrorKind::NotFound {
        127
    } else {
        126
    }
}

#[cfg(not(unix))]
fn plain_exec(file: &OsStr, argv: &[OsString]) -> i32 {
    match Command::new(file)
        .args(argv.get(1..).unwrap_or(&[]))
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!("Failed to start {}: {err}", file.to_string_lossy());
            127
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_int, c_short, c_void, CString, OsStr, OsString};
    use std::os::unix::ffi::OsStrExt;

    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    // <spawn.h>
    const POSIX_SPAWN_SETSIGDEF: c_short = 0x0004;
    const POSIX_SPAWN_SETSIGMASK: c_short = 0x0008;
    const POSIX_SPAWN_SETEXEC: c_short = 0x0040;

    type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;
    type ResponsibleFor = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

    fn symbol(name: &str) -> Option<*mut c_void> {
        let name = CString::new(name).ok()?;
        let found = unsafe { libc::dlsym(RTLD_DEFAULT, name.as_ptr()) };
        (!found.is_null()).then_some(found)
    }

    pub fn responsible_pid(pid: i32) -> Option<i32> {
        let f: ResponsibleFor =
            unsafe { std::mem::transmute(symbol("responsibility_get_pid_responsible_for_pid")?) };
        let responsible = unsafe { f(pid) };
        (responsible > 0).then_some(responsible)
    }

    /// The file to execute, and the arguments the child sees, as C strings made before anything forks or spawns.
    /// `argv[0]` may be a different name from `file` (a same-folder multi-call link).
    pub struct Prepared {
        file: CString,
        argv: Vec<CString>,
    }

    impl Prepared {
        pub fn new(file: &OsStr, argv: &[OsString]) -> Result<Self, String> {
            let file = CString::new(file.as_bytes())
                .map_err(|_| "the program path holds a NUL byte".to_string())?;
            let argv = argv
                .iter()
                .map(|a| CString::new(a.as_bytes()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "an argument holds a NUL byte".to_string())?;
            if argv.is_empty() {
                return Err("no program".into());
            }
            Ok(Self { file, argv })
        }

        /// Become the program, disclaimed. Returns only when that failed.
        pub fn exec(&self) -> String {
            let Some(set_disclaim) = symbol("responsibility_spawnattrs_setdisclaim") else {
                return "responsibility_spawnattrs_setdisclaim isn't available".into();
            };
            let set_disclaim: SetDisclaim = unsafe { std::mem::transmute(set_disclaim) };
            let mut ptrs: Vec<*mut c_char> = self
                .argv
                .iter()
                .map(|a| a.as_ptr() as *mut c_char)
                .collect();
            ptrs.push(std::ptr::null_mut());
            unsafe {
                let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
                let rc = libc::posix_spawnattr_init(&mut attr);
                if rc != 0 {
                    return format!(
                        "posix_spawnattr_init: {}",
                        std::io::Error::from_raw_os_error(rc)
                    );
                }
                // Start the CLI with default SIGPIPE and an empty signal mask, as std's spawn does for a plain child
                // (this binary's Rust runtime ignores SIGPIPE, and an ignored signal survives exec).
                let mut empty: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut empty);
                let mut defaults: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut defaults);
                libc::sigaddset(&mut defaults, libc::SIGPIPE);
                let why = (|| {
                    let step = |name: &str, rc: c_int| {
                        (rc != 0)
                            .then(|| format!("{name}: {}", std::io::Error::from_raw_os_error(rc)))
                    };
                    if let Some(e) = step(
                        "setflags",
                        libc::posix_spawnattr_setflags(
                            &mut attr,
                            POSIX_SPAWN_SETEXEC | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK,
                        ),
                    ) {
                        return e;
                    }
                    if let Some(e) = step(
                        "setsigmask",
                        libc::posix_spawnattr_setsigmask(&mut attr, &empty),
                    ) {
                        return e;
                    }
                    if let Some(e) = step(
                        "setsigdefault",
                        libc::posix_spawnattr_setsigdefault(&mut attr, &defaults),
                    ) {
                        return e;
                    }
                    if let Some(e) = step("setdisclaim", set_disclaim(&mut attr, 1)) {
                        return e;
                    }
                    let mut pid: libc::pid_t = 0;
                    let rc = libc::posix_spawnp(
                        &mut pid,
                        self.file.as_ptr(),
                        std::ptr::null(),
                        &attr,
                        ptrs.as_ptr(),
                        *libc::_NSGetEnviron() as *const *mut c_char,
                    );
                    format!("posix_spawnp: {}", std::io::Error::from_raw_os_error(rc))
                })();
                libc::posix_spawnattr_destroy(&mut attr);
                why
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn disclaimed_exec(file: &OsStr, argv: &[OsString]) -> Result<std::convert::Infallible, String> {
    Err(mac::Prepared::new(file, argv)?.exec())
}

#[cfg(not(target_os = "macos"))]
fn disclaimed_exec(_file: &OsStr, _argv: &[OsString]) -> Result<std::convert::Infallible, String> {
    Err("disclaim is macOS only".into())
}

#[cfg(target_os = "macos")]
pub fn responsible_pid(pid: i32) -> Option<i32> {
    mac::responsible_pid(pid)
}

#[cfg(not(target_os = "macos"))]
pub fn responsible_pid(_pid: i32) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    struct Dir(PathBuf);
    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> Dir {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "monocode-disclaim-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }

    #[test]
    fn the_switch_reads_off_words_and_the_environment_wins() {
        assert!(!switched_off(None, None));
        assert!(switched_off(None, Some("off\n")));
        assert!(switched_off(None, Some(" FALSE ")));
        assert!(!switched_off(None, Some("on")));
        assert!(switched_off(Some(OsStr::new("0")), Some("on")));
        assert!(!switched_off(Some(OsStr::new("1")), Some("off")));
    }

    #[test]
    fn the_setting_file_turns_it_off() {
        let dir = tempdir();
        std::fs::create_dir_all(dir.path().join("settings")).unwrap();
        std::fs::write(dir.path().join("settings").join(SETTING_FILE), "off\n").unwrap();
        if std::env::var_os(ENV_SWITCH).is_none() {
            assert!(!enabled(Some(dir.path())));
            assert_eq!(launcher_for(OsStr::new("/bin/sh"), Some(dir.path())), None);
        }
    }

    #[test]
    fn default_is_on_for_macos_only() {
        if std::env::var_os(ENV_SWITCH).is_none() {
            assert_eq!(enabled(None), cfg!(target_os = "macos"));
        }
    }

    #[test]
    fn a_missing_cli_gets_no_launcher_so_it_fails_as_before() {
        assert_eq!(launcher_for(OsStr::new("/no/such/cli-r53"), None), None);
        assert_eq!(launcher_for(OsStr::new("no-such-cli-r53"), None), None);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_finds_paths_and_path_entries() {
        assert_eq!(
            resolve(OsStr::new("/bin/sh"), None),
            Some(PathBuf::from("/bin/sh"))
        );
        assert_eq!(
            resolve(OsStr::new("sh"), Some(OsStr::new("/nope:/bin"))),
            Some(PathBuf::from("/bin/sh"))
        );
        assert_eq!(resolve(OsStr::new("sh"), None), None);
        assert_eq!(resolve(OsStr::new("/etc/hosts"), None), None);
    }

    #[test]
    fn the_launcher_command_carries_the_program_and_later_args() {
        let mut cmd = command(
            OsStr::new("/usr/local/bin/claude"),
            Some(Path::new("/A/monocode")),
            None,
        );
        cmd.args(["--print", "hi"]);
        assert_eq!(cmd.get_program(), OsStr::new("/A/monocode"));
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(
            args,
            [
                "disclaim-exec",
                "--",
                "/usr/local/bin/claude",
                "--print",
                "hi"
            ]
        );
        let plain = command(OsStr::new("claude"), None, None);
        assert_eq!(plain.get_program(), OsStr::new("claude"));
        assert_eq!(plain.get_args().count(), 0);
    }

    #[test]
    fn a_wrapped_command_keeps_the_invoked_name() {
        let cmd = command(
            OsStr::new("/usr/local/bin/bun"),
            Some(Path::new("/A/monocode")),
            Some(OsStr::new("/usr/local/bin/bunx")),
        );
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(
            args,
            [
                "disclaim-exec",
                "--argv0",
                "/usr/local/bin/bunx",
                "--",
                "/usr/local/bin/bun",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_direct_start_shows_the_invoked_name_as_argv0() {
        let mut cmd = command(OsStr::new("/bin/sh"), None, Some(OsStr::new("bunx")));
        cmd.arg("-c").arg("printf %s \"$0\"");
        let out = cmd.output().expect("spawn");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "bunx");
    }

    #[test]
    fn launcher_arguments_parse() {
        assert!(matches!(
            parse(&os(&["--", "a", "b"])),
            Ok(Request::Exec { ref file, ref argv }) if file == "a" && argv == &os(&["a", "b"])
        ));
        assert!(matches!(
            parse(&os(&["--argv0", "bunx", "--", "/bin/bun", "-x"])),
            Ok(Request::Exec { ref file, ref argv })
                if file == "/bin/bun" && argv == &os(&["bunx", "-x"])
        ));
        assert!(parse(&os(&["--argv0", "bunx"])).is_err());
        assert!(matches!(
            parse(&os(&["--responsible", "42"])),
            Ok(Request::Responsible(42))
        ));
        assert!(parse(&os(&["--"])).is_err());
        assert!(parse(&os(&[])).is_err());
        assert!(parse(&os(&["a"])).is_err());
        assert!(parse(&os(&["--responsible", "x"])).is_err());
    }

    /// The real thing on macOS: a child that becomes `sh` through the disclaimed exec keeps the pid, the pipes,
    /// the working directory and its own process group, has default SIGPIPE, and is responsible for itself.
    #[cfg(target_os = "macos")]
    #[test]
    fn disclaimed_exec_keeps_pid_pipes_cwd_and_group() {
        use std::io::Read;
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        let dir = tempdir();
        let cwd = std::fs::canonicalize(dir.path()).unwrap();
        let script =
            "echo pid=$$; echo pgid=$(ps -o pgid= -p $$ | tr -d ' '); echo cwd=$(pwd -P); \
                      echo sigpipe=$(trap -p PIPE); read line; echo got=$line; sleep 2";
        let prepared =
            mac::Prepared::new(OsStr::new("/bin/sh"), &os(&["/bin/sh", "-c", script])).unwrap();
        let mut cmd = Command::new("/usr/bin/true");
        cmd.current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        unsafe {
            cmd.pre_exec(move || {
                let _ = prepared.exec();
                Err(std::io::Error::other("disclaimed exec failed"))
            });
        }
        let mut child = cmd.spawn().expect("spawn");
        let pid = child.id() as i32;
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), b"hello\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
        let responsible = responsible_pid(pid);
        let mut out = String::new();
        let _ = child.wait();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        assert!(out.contains(&format!("pid={pid}\n")), "{out}");
        assert!(out.contains(&format!("pgid={pid}\n")), "{out}");
        assert!(out.contains(&format!("cwd={}\n", cwd.display())), "{out}");
        assert!(out.contains("sigpipe=\n"), "{out}");
        assert!(out.contains("got=hello\n"), "{out}");
        assert_eq!(
            responsible,
            Some(pid),
            "the CLI should be responsible for itself"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_plain_child_is_not_responsible_for_itself() {
        let mut child = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let pid = child.id() as i32;
        std::thread::sleep(std::time::Duration::from_millis(200));
        let responsible = responsible_pid(pid);
        let _ = child.kill();
        let _ = child.wait();
        let responsible = responsible.expect("macOS names a responsible pid");
        assert_ne!(responsible, pid);
    }
}
