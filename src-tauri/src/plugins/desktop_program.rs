//! WP-44: put agent-desktop where the gate looks. The tarball is checked, then only this
//! platform's binary and helper are written. The package's scripts are never run.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::fsutil;
use super::registry::Host;
use super::source::sha512_integrity;

pub const TARBALL_URL: &str = "https://registry.npmjs.org/agent-desktop/-/agent-desktop-1.2.0.tgz";
pub const TARBALL_INTEGRITY: &str =
    "sha512-sp8hHs8JfnuZe8ZQwiKZrqSOlu26SSeZXkjDog4KsU31L09G3uZJa8pITGN2vORif9uuh0iOSJHD146CEyTqag==";

const MAX_TARBALL: u64 = 128 * 1024 * 1024;
const PIN_NOT_SET: &str = "The desktop program's pin isn't set (agent-desktop 1.2.0).";
const NOT_INSTALLED: &str = "Desktop control isn't installed.";
const TRY_AGAIN: &str = "The desktop program couldn't be downloaded. Try again.";
const LEAVES: &str = "The download holds a path that leaves its folder, so it was refused.";
const MISMATCH: &str = "The download doesn't match the pin, so it was refused.";

/// One platform's files inside `package/bin`, and the hashes of those files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformFiles {
    pub binary_name: String,
    pub sha256: String,
    pub helper_name: Option<String>,
    pub helper_sha256: Option<String>,
}

/// `process.platform-process.arch`, which is what pin.json uses. Rust's own names differ.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Installed names. The tarball names stay in the pin; the files on disk use these.
pub fn install_names(platform: &str) -> Option<(&'static str, Option<&'static str>)> {
    if platform.starts_with("win32-") {
        Some(("agent-desktop.exe", None))
    } else if platform.starts_with("linux-") {
        Some(("agent-desktop", Some("agent-desktop-linux-clipboard-owner")))
    } else if platform.starts_with("darwin-") {
        Some(("agent-desktop", Some("agent-desktop-macos-helper")))
    } else {
        None
    }
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn same_hash(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected)
}

/// A path leaves the archive when any component is not a normal name. `..` and an absolute
/// path are refused before anything is written. Same rule as `unpack_tar`.
fn leaves_archive(path: &Path) -> bool {
    path.components()
        .filter(|component| !matches!(component, Component::CurDir))
        .any(|component| !matches!(component, Component::Normal(_)))
}

fn normal_path(path: &Path) -> Option<PathBuf> {
    if leaves_archive(path) {
        return None;
    }
    let rel: PathBuf = path
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    if rel.as_os_str().is_empty() {
        None
    } else {
        Some(rel)
    }
}

fn read_archive(bytes: &[u8]) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?;
    let mut files = Vec::new();
    for entry in entries {
        let mut entry =
            entry.map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?;
        let path = entry
            .path()
            .map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?
            .into_owned();
        if leaves_archive(&path) {
            return Err(LEAVES.into());
        }
        let Some(rel) = normal_path(&path) else {
            continue;
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?;
        files.push((rel, buf));
    }
    Ok(files)
}

fn file_named<'a>(files: &'a [(PathBuf, Vec<u8>)], name: &str) -> Result<&'a [u8], String> {
    let want = Path::new("package").join("bin").join(name);
    files
        .iter()
        .find(|(path, _)| path == &want)
        .map(|(_, bytes)| bytes.as_slice())
        .ok_or_else(|| format!("The download has no {name}, so it was refused."))
}

fn file_name_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && name != "."
        && name != ".."
}

/// `dest` must already exist. A link is refused. The file name cannot leave `dest`.
fn write_inside(dest: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    if !file_name_ok(name) {
        return Err("The desktop program's file name isn't usable.".into());
    }
    let meta = std::fs::symlink_metadata(dest).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("The desktop folder is a link, so it was refused.".into());
    }
    let dest = fsutil::canonical(dest).map_err(|e| e.to_string())?;
    let path = dest.join(name);
    if path.parent() != Some(dest.as_path()) {
        return Err("Refusing to write outside the desktop folder.".into());
    }
    let part = dest.join(format!(".{name}.part"));
    if part.parent() != Some(dest.as_path()) {
        return Err("Refusing to write outside the desktop folder.".into());
    }
    let write = (|| {
        std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
        set_mode(&part)?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if write.is_err() && part.parent() == Some(dest.as_path()) {
        let _ = std::fs::remove_file(&part);
    }
    write
}

#[cfg(unix)]
fn set_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn set_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Check the tarball and write this platform's program. On any refusal, `dest` is unchanged.
pub fn install_program(
    bytes: &[u8],
    integrity: &str,
    platform: &str,
    entry: &PlatformFiles,
    dest: &Path,
) -> Result<(), String> {
    if sha512_integrity(bytes) != integrity {
        return Err(MISMATCH.into());
    }
    let (binary_install, helper_install) =
        install_names(platform).ok_or_else(|| PIN_NOT_SET.to_string())?;
    if entry.binary_name.is_empty() || !hex64(&entry.sha256) {
        return Err(PIN_NOT_SET.into());
    }
    match (&helper_install, &entry.helper_name, &entry.helper_sha256) {
        (Some(_), Some(name), Some(hash)) if !name.is_empty() && hex64(hash) => {}
        (None, None, None) => {}
        _ => return Err(PIN_NOT_SET.into()),
    }
    let files = read_archive(bytes)?;
    let binary = file_named(&files, &entry.binary_name)?;
    if !same_hash(&sha256_hex(binary), &entry.sha256) {
        return Err(MISMATCH.into());
    }
    let helper = if let Some(name) = &entry.helper_name {
        let bytes = file_named(&files, name)?;
        let expected = entry.helper_sha256.as_deref().unwrap_or("");
        if !same_hash(&sha256_hex(bytes), expected) {
            return Err(MISMATCH.into());
        }
        Some(bytes)
    } else {
        None
    };
    // Every check passed. A failure before this line writes nothing. A link is not followed.
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err("The desktop folder is a link, so it was refused.".into());
        }
        if !meta.is_dir() {
            return Err("The desktop folder isn't a folder.".into());
        }
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    write_inside(dest, binary_install, binary)?;
    if let (Some(name), Some(bytes)) = (helper_install, helper) {
        write_inside(dest, name, bytes)?;
    }
    Ok(())
}

fn platform_files(pin: &Value, platform: &str) -> Result<PlatformFiles, String> {
    let entry = pin
        .get("platforms")
        .and_then(|v| v.get(platform))
        .ok_or_else(|| "This computer isn't in the desktop program's pin.".to_string())?;
    let binary_name = entry
        .get("binary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sha256 = entry
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let helper_name = entry
        .get("helper")
        .and_then(Value::as_str)
        .map(str::to_string);
    let helper_sha256 = entry
        .get("helperSha256")
        .and_then(Value::as_str)
        .map(str::to_string);
    if binary_name.is_empty() || !hex64(&sha256) {
        return Err(PIN_NOT_SET.into());
    }
    match install_names(platform) {
        Some((_, Some(_))) => {
            if helper_name.as_deref().unwrap_or("").is_empty()
                || !hex64(helper_sha256.as_deref().unwrap_or(""))
            {
                return Err(PIN_NOT_SET.into());
            }
        }
        Some((_, None)) => {
            if helper_name.is_some() || helper_sha256.is_some() {
                return Err(PIN_NOT_SET.into());
            }
        }
        None => return Err(PIN_NOT_SET.into()),
    }
    Ok(PlatformFiles {
        binary_name,
        sha256,
        helper_name,
        helper_sha256,
    })
}

/// Read the installed pin and write the program into the plugin's data folder.
/// `download` is the only place a test can stand in for the network.
pub fn fetch_for_host(
    host: &Host,
    platform: &str,
    download: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let pin_path = host.installed("desktop-control").join("pin.json");
    if !pin_path.is_file() {
        return Err(NOT_INSTALLED.into());
    }
    let text = std::fs::read_to_string(&pin_path).map_err(|_| PIN_NOT_SET.to_string())?;
    if text.len() > 64 * 1024 {
        return Err(PIN_NOT_SET.into());
    }
    let pin: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| PIN_NOT_SET.to_string())?;
    if pin.get("integrity").and_then(Value::as_str) != Some(TARBALL_INTEGRITY) {
        return Err(PIN_NOT_SET.into());
    }
    if pin.get("url").and_then(Value::as_str) != Some(TARBALL_URL) {
        return Err(PIN_NOT_SET.into());
    }
    let entry = platform_files(&pin, platform)?;
    let bytes = download(TARBALL_URL)?;
    install_program(
        &bytes,
        TARBALL_INTEGRITY,
        platform,
        &entry,
        &host.data("desktop-control"),
    )
}

/// The one download. A timeout or a bad answer is not a final failure: the person can try again.
pub fn download_tarball(url: &str) -> Result<Vec<u8>, String> {
    if url != TARBALL_URL {
        return Err(PIN_NOT_SET.into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .build();
    // The body is the tarball itself. Don't let a content encoding change the bytes the pin is checked against.
    let response = agent
        .get(url)
        .set("Accept-Encoding", "identity")
        .call()
        .map_err(|_| TRY_AGAIN.to_string())?;
    let mut reader = response.into_reader().take(MAX_TARBALL + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|_| TRY_AGAIN.to_string())?;
    if bytes.len() as u64 > MAX_TARBALL {
        return Err(TRY_AGAIN.into());
    }
    Ok(bytes)
}
