//! WP-43. The browser engine is a pinned npm package, installed into the plugin's data folder.
//! Nothing is taken from PATH or from a worker's checkout, and install scripts are not run.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

const NOT_A_PIN: &str = "The browser engine pin isn't a real checksum, so it was not installed.";
const NOT_OURS: &str = "The browser engine isn't the pinned one.";
const NOT_INSTALLED: &str = "The browser engine isn't installed.";
const NOT_IN_FOLDER: &str = "The browser installer isn't in its own folder.";
const TRY_DOWNLOAD: &str = "The browser couldn't be downloaded. Try again.";
const BUSY: &str = "The browser engine is already being installed.";
const CHROME: &str = "This uses Google Chrome.";
const NO_CHROME: &str = "Google Chrome isn't installed.";

/// What Settings shows for the browser this plugin drives.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineRow {
    pub chrome: bool,
    pub message: String,
}

/// Where to look for Google Chrome. A test passes one path, or says it is missing.
pub enum ChromeLook {
    Default,
    Missing,
    At(PathBuf),
}

/// `HIVRA_BROWSER_CHROME_ROOT` overrides the known install. An empty value means it is missing.
pub fn chrome_look() -> ChromeLook {
    match std::env::var("HIVRA_BROWSER_CHROME_ROOT") {
        Ok(value) if value.is_empty() => ChromeLook::Missing,
        Ok(value) => ChromeLook::At(PathBuf::from(value)),
        Err(_) => ChromeLook::Default,
    }
}

pub fn engine_row(look: ChromeLook) -> EngineRow {
    let chrome = chrome_present(&look);
    EngineRow {
        chrome,
        message: if chrome { CHROME } else { NO_CHROME }.to_string(),
    }
}

fn chrome_present(look: &ChromeLook) -> bool {
    match look {
        ChromeLook::Missing => false,
        ChromeLook::At(path) => !path.as_os_str().is_empty() && path.exists(),
        ChromeLook::Default => default_chrome_roots().iter().any(|path| path.exists()),
    }
}

fn default_chrome_roots() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        return vec![PathBuf::from("/Applications/Google Chrome.app")];
    }
    if cfg!(windows) {
        let mut roots = Vec::new();
        for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Some(dir) = std::env::var_os(key) {
                roots.push(
                    PathBuf::from(dir)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
            }
        }
        return roots;
    }
    vec![
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/google-chrome-stable"),
    ]
}

struct Pin {
    package: String,
    version: String,
    integrity: String,
}

/// Install the pinned engine and its two dependencies under `data/node_modules`.
/// A pin that is not a real checksum never starts npm. A failed download writes nothing.
pub fn install_engine(
    installed: &Path,
    data: &Path,
    tools: &crate::plugins::Tools,
) -> Result<(), String> {
    let pins = read_pins(installed)?;
    for pin in &pins {
        if !crate::plugins::real_sha512_pin(&pin.integrity) {
            return Err(NOT_A_PIN.into());
        }
    }
    let data = prepared_data(data)?;
    let _lock = lock_data(&data)?;
    let job = data
        .join(".engine-work")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&job).map_err(|error| error.to_string())?;
    let result = install_into(&data, &job, &pins, tools);
    remove_work(&data, &job);
    let _ = std::fs::remove_dir(data.join(".engine-work"));
    result
}

fn prepared_data(data: &Path) -> Result<PathBuf, String> {
    if !data.exists() {
        std::fs::create_dir_all(data).map_err(|error| error.to_string())?;
    }
    crate::fs::canonical(data).map_err(|error| error.to_string())
}

fn install_into(
    data: &Path,
    job: &Path,
    pins: &[Pin],
    tools: &crate::plugins::Tools,
) -> Result<(), String> {
    let stage = job.join("stage");
    std::fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
    for pin in pins {
        let dest = stage.join(package_rel(&pin.package)?);
        crate::plugins::pack_exact(
            tools,
            &pin.package,
            &pin.version,
            &pin.integrity,
            &dest,
            job,
        )?;
    }
    let modules = stage.join("node_modules");
    if !modules.is_dir() {
        return Err(NOT_INSTALLED.into());
    }
    publish(data, &modules)
}

fn package_rel(name: &str) -> Result<PathBuf, String> {
    Ok(match name {
        "@playwright/mcp" => PathBuf::from("node_modules")
            .join("@playwright")
            .join("mcp"),
        "playwright" => PathBuf::from("node_modules").join("playwright"),
        "playwright-core" => PathBuf::from("node_modules").join("playwright-core"),
        _ => return Err(NOT_OURS.into()),
    })
}

fn publish(data: &Path, fresh: &Path) -> Result<(), String> {
    let live = data.join("node_modules");
    let backup = fresh
        .parent()
        .and_then(Path::parent)
        .map(|job| job.join("previous-modules"))
        .ok_or_else(|| NOT_INSTALLED.to_string())?;
    if live.exists() {
        std::fs::rename(&live, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = std::fs::rename(fresh, &live) {
        if backup.exists() && !live.exists() {
            let _ = std::fs::rename(&backup, &live);
        }
        return Err(error.to_string());
    }
    Ok(())
}

fn read_pins(installed: &Path) -> Result<Vec<Pin>, String> {
    let text =
        std::fs::read_to_string(installed.join("engine.json")).map_err(|_| NOT_OURS.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| NOT_OURS.to_string())?;
    let package = value.get("package").and_then(Value::as_str).unwrap_or("");
    if package != "@playwright/mcp" {
        return Err(NOT_OURS.into());
    }
    let mut pins = vec![one_pin(package, &value)?];
    let Some(deps) = value.get("dependencies").and_then(Value::as_array) else {
        return Err(NOT_OURS.into());
    };
    let mut seen = std::collections::BTreeSet::new();
    for dep in deps {
        let name = dep.get("package").and_then(Value::as_str).unwrap_or("");
        if name != "playwright" && name != "playwright-core" {
            return Err(NOT_OURS.into());
        }
        if !seen.insert(name.to_string()) {
            return Err(NOT_OURS.into());
        }
        pins.push(one_pin(name, dep)?);
    }
    if seen.len() != 2 {
        return Err(NOT_OURS.into());
    }
    Ok(pins)
}

fn one_pin(package: &str, value: &Value) -> Result<Pin, String> {
    let version = value.get("version").and_then(Value::as_str).unwrap_or("");
    if version.is_empty()
        || version.len() > 100
        || version.contains("..")
        || version.starts_with(['.', '-'])
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(NOT_OURS.into());
    }
    let integrity = value.get("integrity").and_then(Value::as_str).unwrap_or("");
    if integrity.len() > 200 {
        return Err(NOT_OURS.into());
    }
    Ok(Pin {
        package: package.to_string(),
        version: version.to_string(),
        integrity: integrity.to_string(),
    })
}

struct EngineLock {
    data: PathBuf,
    path: PathBuf,
}

impl Drop for EngineLock {
    fn drop(&mut self) {
        let Ok(data) = crate::fs::canonical(&self.data) else {
            return;
        };
        let Ok(path) = crate::fs::canonical(&self.path) else {
            return;
        };
        if path.starts_with(&data)
            && path.file_name().and_then(|name| name.to_str()) == Some(".engine-install.lock")
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn lock_data(data: &Path) -> Result<EngineLock, String> {
    let path = data.join(".engine-install.lock");
    if let Some(lock) = create_lock(data, &path) {
        return Ok(lock);
    }
    let owner = std::fs::read_to_string(&path).unwrap_or_default();
    if owner_alive(&owner) || !lock_file(data, &path) {
        return Err(BUSY.into());
    }
    let _ = std::fs::remove_file(&path);
    create_lock(data, &path).ok_or_else(|| BUSY.into())
}

fn lock_file(data: &Path, path: &Path) -> bool {
    path.parent() == Some(data)
        && path.file_name().and_then(|name| name.to_str()) == Some(".engine-install.lock")
}

fn create_lock(data: &Path, path: &Path) -> Option<EngineLock> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .ok()?;
    let _ = writeln!(file, "{}", std::process::id());
    Some(EngineLock {
        data: data.to_path_buf(),
        path: path.to_path_buf(),
    })
}

fn owner_alive(text: &str) -> bool {
    let Ok(pid) = text.trim().parse::<u32>() else {
        return false;
    };
    process_alive(pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid < 2 {
        return false;
    }
    unsafe {
        if libc::kill(pid, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    if pid < 2 {
        return false;
    }
    let mut command = Command::new("tasklist");
    command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null());
    command
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(true)
}

fn remove_work(data: &Path, job: &Path) {
    let Ok(data) = crate::fs::canonical(data) else {
        return;
    };
    let Ok(job) = crate::fs::canonical(job) else {
        return;
    };
    if job == data || !job.starts_with(&data) {
        return;
    }
    let in_work = job
        .ancestors()
        .any(|part| part.file_name().and_then(|name| name.to_str()) == Some(".engine-work"));
    if in_work {
        let _ = std::fs::remove_dir_all(job);
    }
}

/// Download Chromium with the engine's own installer. Node and the installer must both be
/// absolute paths, and the installer must be the playwright cli inside `data`.
pub fn get_browser(data: &Path) -> Result<(), String> {
    let node = absolute_node()?;
    let cli = data.join("node_modules").join("playwright").join("cli.js");
    fetch_chromium(data, &node, &cli)
}

fn absolute_node() -> Result<PathBuf, String> {
    let mut command = Command::new("node");
    command
        .arg("-e")
        .arg("process.stdout.write(process.execPath)");
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null());
    let out = command
        .output()
        .map_err(|_| "Node couldn't be found.".to_string())?;
    if !out.status.success() {
        return Err("Node couldn't be found.".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.contains(['\n', '\r']) || !Path::new(text).is_absolute() {
        return Err("Node isn't an absolute path.".into());
    }
    Ok(PathBuf::from(text))
}

fn fetch_chromium(data: &Path, node: &Path, cli: &Path) -> Result<(), String> {
    if !node.is_absolute() {
        return Err("Node isn't an absolute path.".into());
    }
    if !cli.is_absolute() {
        return Err(NOT_IN_FOLDER.into());
    }
    let data = crate::fs::canonical(data).map_err(|_| NOT_INSTALLED.to_string())?;
    let cli = crate::fs::canonical(cli).map_err(|_| NOT_INSTALLED.to_string())?;
    let expected = data.join("node_modules").join("playwright").join("cli.js");
    if cli != expected {
        return Err(NOT_IN_FOLDER.into());
    }
    let mut command = Command::new(node);
    command.arg(&cli).args(["install", "chromium"]);
    command.current_dir(&data);
    command.env_clear();
    command.env("PLAYWRIGHT_BROWSERS_PATH", data.join("browsers"));
    command.stdin(Stdio::null());
    let out = command.output().map_err(|_| TRY_DOWNLOAD.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(TRY_DOWNLOAD.into())
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;
    use crate::plugins::{Target, Tools};

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "hivra engine {label} {} {}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(crate::fs::canonical(&path).unwrap())
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Pack {
        package: String,
        version: String,
        spec: String,
        file: String,
        /// What `npm view` reports. A test can make this differ from the file.
        reported: String,
        bytes: Vec<u8>,
    }

    fn gzip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut raw = tar::Builder::new(Vec::new());
        for (rel, text) in files {
            let bytes = text.as_bytes();
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            raw.append_data(&mut header, format!("package/{rel}"), bytes)
                .unwrap();
        }
        let raw = raw.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        gz.finish().unwrap()
    }

    fn pack(package: &str, version: &str, files: &[(&str, &str)]) -> Pack {
        let bytes = gzip(files);
        let reported = crate::plugins::sha512_integrity(&bytes);
        Pack {
            package: package.to_string(),
            version: version.to_string(),
            spec: format!("{package}@{version}"),
            file: format!("{}.tgz", package.replace('/', "-")),
            reported,
            bytes,
        }
    }

    const STUB: &str = r#"#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const cmd = args[0];
const dir = __dirname;
fs.appendFileSync(path.join(dir, "npm-log.txt"), JSON.stringify({ cmd, args, cwd: process.cwd() }) + "\n");
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const spec = args[args.length - 1];
const row = meta[spec];
if (!row) {
  process.stderr.write("no " + spec + "\n");
  process.exit(1);
}
if (cmd === "view") {
  process.stdout.write(JSON.stringify({ version: row.version, dist: { integrity: row.integrity } }));
  process.exit(0);
}
if (cmd === "pack") {
  if (!args.includes("--ignore-scripts")) {
    process.stderr.write("scripts\n");
    process.exit(1);
  }
  const at = args.indexOf("--pack-destination");
  if (at < 0 || !args[at + 1]) {
    process.stderr.write("no destination\n");
    process.exit(1);
  }
  fs.copyFileSync(path.join(dir, row.file), path.join(args[at + 1], row.file));
  process.stdout.write(JSON.stringify([{ filename: row.file }]));
  process.exit(0);
}
process.stderr.write("unexpected " + args.join(" ") + "\n");
process.exit(1);
"#;

    fn npm_tools(dir: &Path, packs: &[Pack]) -> Tools {
        std::fs::create_dir_all(dir).unwrap();
        let mut meta = serde_json::Map::new();
        for pack in packs {
            std::fs::write(dir.join(&pack.file), &pack.bytes).unwrap();
            meta.insert(
                pack.spec.clone(),
                json!({
                    "version": pack.version,
                    "integrity": pack.reported,
                    "file": pack.file,
                }),
            );
        }
        std::fs::write(dir.join("meta.json"), serde_json::to_vec(&meta).unwrap()).unwrap();
        let js = dir.join("npm-stub.js");
        std::fs::write(&js, STUB).unwrap();
        #[cfg(unix)]
        let program = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&js, std::fs::Permissions::from_mode(0o755)).unwrap();
            js
        };
        #[cfg(windows)]
        let program = {
            let cmd = dir.join("npm-stub.cmd");
            std::fs::write(&cmd, "@echo off\r\nnode \"%~dp0npm-stub.js\" %*\r\n").unwrap();
            cmd
        };
        Tools {
            git: OsString::from("git-must-not-run"),
            npm: program.into_os_string(),
            path: Some(front_path(dir)),
            target: Target::here(),
        }
    }

    fn front_path(front: &Path) -> OsString {
        let mut path = front.as_os_str().to_os_string();
        if let Some(rest) = std::env::var_os("PATH") {
            path.push(if cfg!(windows) { ";" } else { ":" });
            path.push(rest);
        }
        path
    }

    fn plant_npx(dir: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let npx = dir.join("npx");
            std::fs::write(
                &npx,
                "#!/bin/sh\necho ran >> \"$(dirname \"$0\")/npx-ran\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        {
            std::fs::write(
                dir.join("npx.cmd"),
                "@echo off\r\necho ran>>\"%~dp0npx-ran\"\r\n",
            )
            .unwrap();
        }
    }

    fn write_engine(installed: &Path, pins: &[(&str, &str, &str)]) {
        std::fs::create_dir_all(installed).unwrap();
        let deps: Vec<_> = pins
            .iter()
            .skip(1)
            .map(|(package, version, integrity)| {
                json!({ "package": package, "version": version, "integrity": integrity })
            })
            .collect();
        let (package, version, integrity) = pins[0];
        let text = serde_json::to_vec_pretty(&json!({
            "package": package,
            "version": version,
            "integrity": integrity,
            "dependencies": deps,
        }))
        .unwrap();
        std::fs::write(installed.join("engine.json"), text).unwrap();
    }

    fn three() -> Vec<Pack> {
        vec![
            pack("@playwright/mcp", "0.0.83", &[("cli.js", "mcp cli\n")]),
            pack(
                "playwright",
                "1.64.0-alpha-1",
                &[("cli.js", "playwright cli\n")],
            ),
            pack(
                "playwright-core",
                "1.64.0-alpha-1",
                &[("index.js", "core\n")],
            ),
        ]
    }

    fn pins_of(packs: &[Pack]) -> Vec<(&str, String, String)> {
        packs
            .iter()
            .map(|pack| {
                (
                    pack.package.as_str(),
                    pack.version.clone(),
                    pack.reported.clone(),
                )
            })
            .collect()
    }

    fn write_from(installed: &Path, rows: &[(&str, String, String)]) {
        let owned: Vec<(&str, &str, &str)> = rows
            .iter()
            .map(|(package, version, integrity)| (*package, version.as_str(), integrity.as_str()))
            .collect();
        write_engine(installed, &owned);
    }

    #[test]
    fn the_row_names_chrome_or_says_it_is_missing() {
        let tmp = Tmp::new("chrome");
        let app = tmp.path().join("Google Chrome.app");
        std::fs::create_dir_all(&app).unwrap();
        let present = engine_row(ChromeLook::At(app));
        assert!(present.chrome);
        assert_eq!(present.message, "This uses Google Chrome.");
        let missing = engine_row(ChromeLook::Missing);
        assert!(!missing.chrome);
        assert_eq!(missing.message, "Google Chrome isn't installed.");
        let gone = engine_row(ChromeLook::At(tmp.path().join("no-such-chrome")));
        assert!(!gone.chrome);
        assert_eq!(gone.message, "Google Chrome isn't installed.");
    }

    #[test]
    fn a_placeholder_pin_does_not_start_npm() {
        let tmp = Tmp::new("placeholder");
        let installed = tmp.path().join("installed");
        let data = tmp.path().join("data");
        let stub = tmp.path().join("stub");
        std::fs::create_dir_all(&stub).unwrap();
        write_engine(
            &installed,
            &[
                ("@playwright/mcp", "0.0.83", "placeholder"),
                ("playwright", "1.64.0-alpha-1", "sha512-aaaa"),
                ("playwright-core", "1.64.0-alpha-1", "placeholder"),
            ],
        );
        let error = install_engine(&installed, &data, &npm_tools(&stub, &[])).unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert!(!stub.join("npm-log.txt").exists());
        assert!(!data.join("node_modules").exists());
    }

    #[test]
    fn a_wrong_checksum_installs_nothing_and_leaves_a_checkout_alone() {
        let tmp = Tmp::new("wrong");
        let installed = tmp.path().join("installed");
        let data = tmp.path().join("data");
        let checkout = tmp.path().join("checkout");
        let decoy = checkout
            .join("node_modules")
            .join("@playwright")
            .join("mcp")
            .join("cli.js");
        std::fs::create_dir_all(decoy.parent().unwrap()).unwrap();
        std::fs::write(&decoy, "decoy\n").unwrap();
        plant_npx(&checkout);
        let packs = three();
        let other = crate::plugins::sha512_integrity(b"not the tarball");
        assert_ne!(other, packs[0].reported);
        write_engine(
            &installed,
            &[
                ("@playwright/mcp", "0.0.83", other.as_str()),
                ("playwright", "1.64.0-alpha-1", packs[1].reported.as_str()),
                (
                    "playwright-core",
                    "1.64.0-alpha-1",
                    packs[2].reported.as_str(),
                ),
            ],
        );
        let error = install_engine(
            &installed,
            &data,
            &npm_tools(&tmp.path().join("stub"), &packs),
        )
        .unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert!(!data.join("node_modules").exists());
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "decoy\n");
        assert!(!checkout.join("npx-ran").exists());
        assert!(!data.join(".engine-work").exists());
    }

    #[test]
    fn a_tarball_that_does_not_match_the_pin_installs_nothing() {
        let tmp = Tmp::new("tarball");
        let installed = tmp.path().join("installed");
        let data = tmp.path().join("data");
        let mut packs = three();
        let pinned = crate::plugins::sha512_integrity(b"pinned bytes");
        packs[0].reported = pinned.clone();
        let rows = pins_of(&packs);
        write_from(&installed, &rows);
        let error = install_engine(
            &installed,
            &data,
            &npm_tools(&tmp.path().join("stub"), &packs),
        )
        .unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert!(!data.join("node_modules").exists());
    }

    #[test]
    fn the_pinned_engine_lands_in_the_data_folder_not_a_checkout() {
        let tmp = Tmp::new("install");
        let installed = tmp.path().join("installed");
        let data = tmp.path().join("data 文件夹");
        let checkout = tmp.path().join("checkout");
        let decoy = checkout
            .join("node_modules")
            .join("@playwright")
            .join("mcp")
            .join("cli.js");
        std::fs::create_dir_all(decoy.parent().unwrap()).unwrap();
        std::fs::write(&decoy, "decoy\n").unwrap();
        plant_npx(&checkout);
        let keep = tmp.path().join("keep");
        std::fs::write(&keep, "stay\n").unwrap();
        let packs = three();
        let rows = pins_of(&packs);
        write_from(&installed, &rows);
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(".engine-install.lock"), "2147483646\n").unwrap();
        install_engine(&installed, &data, &npm_tools(&checkout, &packs)).unwrap();
        let root = data.join("node_modules");
        assert_eq!(
            std::fs::read_to_string(root.join("@playwright").join("mcp").join("cli.js")).unwrap(),
            "mcp cli\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("playwright").join("cli.js")).unwrap(),
            "playwright cli\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("playwright-core").join("index.js")).unwrap(),
            "core\n"
        );
        assert_eq!(std::fs::read_to_string(&decoy).unwrap(), "decoy\n");
        assert!(!checkout.join("npx-ran").exists());
        assert_eq!(std::fs::read_to_string(&keep).unwrap(), "stay\n");
        assert!(!data.join(".engine-work").exists());
        assert!(!data.join(".engine-install.lock").exists());
        let log = std::fs::read_to_string(checkout.join("npm-log.txt")).unwrap();
        let data_real = crate::fs::canonical(&data).unwrap();
        let checkout_real = crate::fs::canonical(&checkout).unwrap();
        for line in log.lines() {
            let row: Value = serde_json::from_str(line).unwrap();
            let cwd = PathBuf::from(row["cwd"].as_str().unwrap());
            assert!(
                cwd.starts_with(&data) || cwd.starts_with(&data_real),
                "{}",
                cwd.display()
            );
            assert!(
                !cwd.starts_with(&checkout) && !cwd.starts_with(&checkout_real),
                "{}",
                cwd.display()
            );
            let args = row["args"].as_array().unwrap();
            if row["cmd"] == "pack" {
                assert!(args.iter().any(|arg| arg == "--ignore-scripts"), "{line}");
            }
            let flat = serde_json::to_string(args).unwrap();
            assert!(!flat.contains("npx"), "{line}");
            assert!(!flat.contains(&checkout.display().to_string()), "{line}");
        }
    }

    #[test]
    fn a_live_install_lock_is_not_stolen() {
        let tmp = Tmp::new("lock");
        let installed = tmp.path().join("installed");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(data.join("node_modules")).unwrap();
        std::fs::write(data.join("node_modules").join("keep.txt"), "stay\n").unwrap();
        let packs = three();
        let rows = pins_of(&packs);
        write_from(&installed, &rows);
        std::fs::write(
            data.join(".engine-install.lock"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();
        let error = install_engine(
            &installed,
            &data,
            &npm_tools(&tmp.path().join("stub"), &packs),
        )
        .unwrap_err();
        assert!(error.contains("already"), "{error}");
        assert_eq!(
            std::fs::read_to_string(data.join("node_modules").join("keep.txt")).unwrap(),
            "stay\n"
        );
        assert!(!tmp.path().join("stub").join("npm-log.txt").exists());
    }

    fn fake_node(dir: &Path) -> PathBuf {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let node = dir.join("node");
            let quote =
                |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
            let script = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nprintf '%s\\n' \"${{PLAYWRIGHT_BROWSERS_PATH-}}\" > {}\nprintf '%s\\n' \"${{PATH-}}\" > {}\npwd > {}\nenv > {}\n",
                quote(&dir.join("args.txt")),
                quote(&dir.join("browsers.txt")),
                quote(&dir.join("path.txt")),
                quote(&dir.join("cwd.txt")),
                quote(&dir.join("env.txt")),
            );
            std::fs::write(&node, script).unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
            node
        }
        #[cfg(windows)]
        {
            let node = dir.join("node.cmd");
            std::fs::write(
                &node,
                "@echo off\r\n> \"%~dp0args.txt\" echo %*\r\n> \"%~dp0browsers.txt\" echo %PLAYWRIGHT_BROWSERS_PATH%\r\n> \"%~dp0path.txt\" echo %PATH%\r\n> \"%~dp0cwd.txt\" echo %CD%\r\n> \"%~dp0env.txt\" set\r\n",
            )
            .unwrap();
            node
        }
    }

    #[test]
    fn getting_the_browser_uses_the_data_folder_and_not_a_chrome_profile() {
        let tmp = Tmp::new("get");
        let data = tmp.path().join("data");
        let cli = data.join("node_modules").join("playwright").join("cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "cli\n").unwrap();
        let node_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = fake_node(&node_dir);
        fetch_chromium(&data, &node, &cli).unwrap();
        let args = std::fs::read_to_string(node_dir.join("args.txt")).unwrap();
        let cli_real = crate::fs::canonical(&cli).unwrap();
        assert!(args.contains(&cli_real.display().to_string()), "{args}");
        assert!(args.contains("install"), "{args}");
        assert!(args.contains("chromium"), "{args}");
        assert!(!args.contains("user-data-dir"), "{args}");
        assert!(!args.contains("Application Support"), "{args}");
        assert!(
            !args.contains("Google/Chrome") && !args.contains("Google\\Chrome"),
            "{args}"
        );
        let browsers = std::fs::read_to_string(node_dir.join("browsers.txt")).unwrap();
        assert_eq!(
            Path::new(browsers.trim()),
            crate::fs::canonical(&data).unwrap().join("browsers")
        );
        let path = std::fs::read_to_string(node_dir.join("path.txt")).unwrap();
        let parent = std::env::var("PATH").unwrap_or_default();
        assert_ne!(path.trim(), parent.trim());
        let dumped = std::fs::read_to_string(node_dir.join("env.txt")).unwrap_or_default();
        assert!(
            !dumped.lines().any(|line| line.starts_with("HOME=")),
            "{dumped}"
        );
        assert!(dumped.contains("PLAYWRIGHT_BROWSERS_PATH="), "{dumped}");
        let cwd = std::fs::read_to_string(node_dir.join("cwd.txt")).unwrap();
        assert_eq!(
            crate::fs::canonical(cwd.trim()).unwrap(),
            crate::fs::canonical(&data).unwrap()
        );
    }

    #[test]
    fn a_relative_node_or_a_checkout_cli_does_not_run() {
        let tmp = Tmp::new("refuse");
        let data = tmp.path().join("data");
        let cli = data.join("node_modules").join("playwright").join("cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "cli\n").unwrap();
        let node_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = fake_node(&node_dir);
        let error = fetch_chromium(&data, Path::new("node"), &cli).unwrap_err();
        assert!(error.contains("absolute"), "{error}");
        assert!(!node_dir.join("args.txt").exists());

        let checkout = tmp.path().join("checkout");
        let outside = checkout
            .join("node_modules")
            .join("playwright")
            .join("cli.js");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::write(&outside, "decoy\n").unwrap();
        let error = fetch_chromium(&data, &node, &outside).unwrap_err();
        assert!(
            error.contains("folder") || error.contains("installed"),
            "{error}"
        );
        assert!(!node_dir.join("args.txt").exists());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "decoy\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_installer_outside_the_data_folder_does_not_run() {
        let tmp = Tmp::new("link");
        let data = tmp.path().join("data");
        let cli = data.join("node_modules").join("playwright").join("cli.js");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        let outside = tmp.path().join("outside.js");
        std::fs::write(&outside, "out\n").unwrap();
        std::os::unix::fs::symlink(&outside, &cli).unwrap();
        let node_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = fake_node(&node_dir);
        let error = fetch_chromium(&data, &node, &cli).unwrap_err();
        assert!(error.contains("folder"), "{error}");
        assert!(!node_dir.join("args.txt").exists());
    }
}
