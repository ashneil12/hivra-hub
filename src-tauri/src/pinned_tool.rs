//! One way to put a pinned tool in the app's data folder (WP-81 owns this file).
//!
//! The bytes are checked before anything is written. An install script in the
//! archive is never run. Only the named program is kept. A fetch that fails is
//! not a final answer: nothing is installed, and the next call tries again.
//!
//! The checks follow `plugins/desktop_program.rs` (WP-44): hash the download,
//! refuse a path that leaves the archive, write the file by a temporary name
//! and rename it. This is not a copy of that installer. A tool's own pin
//! (version, asset names, checksums) lives with that tool, not here.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
const LOCK_STALE: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Clone, Copy, Debug)]
pub struct ToolAsset {
    pub os: &'static str,
    pub arch: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub archive: ArchiveKind,
    pub binary_name: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct ToolPin {
    pub name: &'static str,
    pub version: &'static str,
    pub assets: &'static [ToolAsset],
}

#[derive(Debug)]
pub enum EnsureError {
    /// The pin has no asset for this machine, or its checksum is not 64 hex
    /// characters. Nothing was downloaded and nothing was written.
    NotPinned(&'static str),
    /// The download's hash did not match. Nothing was written.
    ChecksumMismatch,
    /// The archive is not usable (a path leaves it, the program is a link,
    /// it is too big). Nothing was written.
    Refused(String),
    /// The download did not finish. Not a final failure.
    Unavailable(String),
}

impl std::fmt::Display for EnsureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotPinned(why) => write!(f, "{why}"),
            Self::ChecksumMismatch => {
                write!(f, "The download doesn't match the pin, so it was refused.")
            }
            Self::Refused(why) => write!(f, "{why}"),
            Self::Unavailable(why) => write!(f, "{why}"),
        }
    }
}

#[derive(Debug)]
pub struct Installed {
    pub binary: PathBuf,
    /// True when this call downloaded the archive. A later call can skip the fetch.
    #[allow(dead_code)]
    pub fetched: bool,
}

pub trait BlobSource {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// Downloads with a size cap. Tests pass a [`BlobSource`] that never touches
/// the network.
pub struct UreqSource;

impl BlobSource for UreqSource {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .build();
        let response = agent
            .get(url)
            .set("Accept-Encoding", "identity")
            .call()
            .map_err(|error| format!("The download didn't finish ({error})."))?;
        let mut body = Vec::new();
        response
            .into_reader()
            .take(MAX_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|error| format!("The download didn't finish ({error})."))?;
        if body.len() as u64 > MAX_BYTES {
            return Err("The download is larger than 64MB, so it was refused.".into());
        }
        Ok(body)
    }
}

pub fn this_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    (os, arch)
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
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

fn name_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value != "."
        && value != ".."
        && !value.starts_with('.')
}

fn asset_for(pin: &ToolPin) -> Result<&ToolAsset, EnsureError> {
    if !name_ok(pin.name) || !name_ok(pin.version) {
        return Err(EnsureError::NotPinned(
            "This tool's name or version isn't usable, so it wasn't installed.",
        ));
    }
    let (os, arch) = this_platform();
    let asset = pin
        .assets
        .iter()
        .find(|asset| asset.os == os && asset.arch == arch)
        .ok_or(EnsureError::NotPinned(
            "This tool has no build for this computer, so it wasn't installed.",
        ))?;
    if !hex64(asset.sha256) || !name_ok(asset.binary_name) || asset.url.is_empty() {
        return Err(EnsureError::NotPinned(
            "This tool's pin isn't set, so it wasn't installed.",
        ));
    }
    Ok(asset)
}

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

fn read_capped(mut reader: impl Read) -> Result<Vec<u8>, EnsureError> {
    let mut buf = Vec::new();
    reader
        .by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|_| {
            EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
        })?;
    if buf.len() as u64 > MAX_BYTES {
        return Err(EnsureError::Refused(
            "The download is larger than 64MB, so it was refused.".into(),
        ));
    }
    Ok(buf)
}

fn extract_tar(bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, EnsureError> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|_| {
        EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
    })?;
    let want = Path::new(binary_name);
    let mut found: Option<Vec<u8>> = None;
    let mut count = 0usize;
    for entry in entries {
        count += 1;
        if count > MAX_ENTRIES {
            return Err(EnsureError::Refused(
                "The download has too many files, so it was refused.".into(),
            ));
        }
        let mut entry = entry.map_err(|_| {
            EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
        })?;
        let path = entry.path().map_err(|_| {
            EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
        })?;
        if leaves_archive(&path) {
            return Err(EnsureError::Refused(
                "The download holds a path that leaves its folder, so it was refused.".into(),
            ));
        }
        let Some(rel) = normal_path(&path) else {
            continue;
        };
        if rel != want {
            // Still cap what we skip, so a huge extra file can't expand forever.
            let _ = read_capped(&mut entry)?;
            continue;
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() || !kind.is_file() {
            return Err(EnsureError::Refused(
                "The download's program is a link, so it was refused.".into(),
            ));
        }
        if entry.header().size().unwrap_or(u64::MAX) > MAX_BYTES {
            return Err(EnsureError::Refused(
                "The download is larger than 64MB, so it was refused.".into(),
            ));
        }
        found = Some(read_capped(&mut entry)?);
    }
    found.ok_or_else(|| {
        EnsureError::Refused(format!(
            "The download has no {binary_name}, so it was refused."
        ))
    })
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn find_eocd(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 22 {
        return None;
    }
    let start = bytes.len().saturating_sub(22 + 65535);
    let mut at = bytes.len() - 22;
    loop {
        if bytes.get(at..at + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]) {
            let comment = read_u16(bytes, at + 20)? as usize;
            if at + 22 + comment == bytes.len() {
                return Some(at);
            }
        }
        if at == start {
            break;
        }
        at -= 1;
    }
    None
}

fn inflate(bytes: &[u8], method: u16) -> Result<Vec<u8>, EnsureError> {
    match method {
        0 => {
            if bytes.len() as u64 > MAX_BYTES {
                return Err(EnsureError::Refused(
                    "The download is larger than 64MB, so it was refused.".into(),
                ));
            }
            Ok(bytes.to_vec())
        }
        8 => read_capped(flate2::read::DeflateDecoder::new(bytes)),
        _ => Err(EnsureError::Refused(
            "The download is packed in a way this app doesn't read, so it was refused.".into(),
        )),
    }
}

fn extract_zip(bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, EnsureError> {
    let eocd = find_eocd(bytes).ok_or_else(|| {
        EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
    })?;
    let count = read_u16(bytes, eocd + 10).ok_or_else(|| {
        EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
    })? as usize;
    if count > MAX_ENTRIES {
        return Err(EnsureError::Refused(
            "The download has too many files, so it was refused.".into(),
        ));
    }
    let cd_size = read_u32(bytes, eocd + 12).ok_or_else(|| {
        EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
    })? as usize;
    let cd_at = read_u32(bytes, eocd + 16).ok_or_else(|| {
        EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
    })? as usize;
    if cd_size > bytes.len() || cd_at > bytes.len() || cd_at + cd_size > bytes.len() {
        return Err(EnsureError::Refused(
            "The download can't be unpacked, so it was refused.".into(),
        ));
    }
    let mut cursor = cd_at;
    let end = cd_at + cd_size;
    let mut found: Option<Vec<u8>> = None;
    for _ in 0..count {
        if cursor + 46 > end || bytes.get(cursor..cursor + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
            return Err(EnsureError::Refused(
                "The download can't be unpacked, so it was refused.".into(),
            ));
        }
        let flags = read_u16(bytes, cursor + 8).unwrap_or(0);
        let method = read_u16(bytes, cursor + 10).unwrap_or(u16::MAX);
        let compressed = read_u32(bytes, cursor + 20).unwrap_or(u32::MAX) as u64;
        let uncompressed = read_u32(bytes, cursor + 24).unwrap_or(u32::MAX) as u64;
        let name_len = read_u16(bytes, cursor + 28).unwrap_or(0) as usize;
        let extra_len = read_u16(bytes, cursor + 30).unwrap_or(0) as usize;
        let comment_len = read_u16(bytes, cursor + 32).unwrap_or(0) as usize;
        let external = read_u32(bytes, cursor + 38).unwrap_or(0);
        let local_at = read_u32(bytes, cursor + 42).unwrap_or(u32::MAX) as usize;
        let name_at = cursor + 46;
        let name_bytes = bytes.get(name_at..name_at + name_len).ok_or_else(|| {
            EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
        })?;
        let name = String::from_utf8_lossy(name_bytes);
        cursor = name_at + name_len + extra_len + comment_len;
        if cursor > end {
            return Err(EnsureError::Refused(
                "The download can't be unpacked, so it was refused.".into(),
            ));
        }
        let path = Path::new(name.as_ref());
        if leaves_archive(path) || name.contains('\\') || name.contains('\0') {
            return Err(EnsureError::Refused(
                "The download holds a path that leaves its folder, so it was refused.".into(),
            ));
        }
        if name != binary_name {
            continue;
        }
        if flags & 1 != 0 {
            return Err(EnsureError::Refused(
                "The download is encrypted, so it was refused.".into(),
            ));
        }
        // Unix mode in the high half of the external attributes. 0120000 is a symlink.
        if (external >> 16) & 0o170000 == 0o120000 {
            return Err(EnsureError::Refused(
                "The download's program is a link, so it was refused.".into(),
            ));
        }
        if uncompressed > MAX_BYTES || compressed > MAX_BYTES || compressed == u32::MAX as u64 {
            return Err(EnsureError::Refused(
                "The download is larger than 64MB, so it was refused.".into(),
            ));
        }
        if local_at + 30 > bytes.len()
            || bytes.get(local_at..local_at + 4) != Some(&[0x50, 0x4b, 0x03, 0x04])
        {
            return Err(EnsureError::Refused(
                "The download can't be unpacked, so it was refused.".into(),
            ));
        }
        let local_name = read_u16(bytes, local_at + 26).unwrap_or(0) as usize;
        let local_extra = read_u16(bytes, local_at + 28).unwrap_or(0) as usize;
        let data_at = local_at + 30 + local_name + local_extra;
        let data_end = data_at + compressed as usize;
        let payload = bytes.get(data_at..data_end).ok_or_else(|| {
            EnsureError::Refused("The download can't be unpacked, so it was refused.".into())
        })?;
        let program = inflate(payload, method)?;
        if program.len() as u64 != uncompressed && uncompressed != 0 {
            return Err(EnsureError::Refused(
                "The download can't be unpacked, so it was refused.".into(),
            ));
        }
        found = Some(program);
    }
    found.ok_or_else(|| {
        EnsureError::Refused(format!(
            "The download has no {binary_name}, so it was refused."
        ))
    })
}

fn extract(bytes: &[u8], kind: ArchiveKind, binary_name: &str) -> Result<Vec<u8>, EnsureError> {
    match kind {
        ArchiveKind::TarGz => extract_tar(bytes, binary_name),
        ArchiveKind::Zip => extract_zip(bytes, binary_name),
    }
}

struct InstallLock {
    path: PathBuf,
}

impl InstallLock {
    fn acquire(dir: &Path) -> Result<Self, EnsureError> {
        std::fs::create_dir_all(dir).map_err(|error| {
            EnsureError::Unavailable(format!("The tools folder couldn't be created ({error})."))
        })?;
        let path = dir.join(".install.lock");
        for _ in 0..40 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path) {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => {
                    return Err(EnsureError::Unavailable(format!(
                        "The tools folder couldn't be locked ({error})."
                    )));
                }
            }
        }
        Err(EnsureError::Unavailable(
            "Another install is still running. Nothing was changed.".into(),
        ))
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > LOCK_STALE)
}

#[cfg(unix)]
fn set_mode(path: &Path) -> Result<(), EnsureError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|error| {
        EnsureError::Unavailable(format!(
            "The program couldn't be marked runnable ({error})."
        ))
    })
}

#[cfg(windows)]
fn set_mode(_path: &Path) -> Result<(), EnsureError> {
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn marker_matches(dir: &Path, version: &str, sha256: &str) -> bool {
    let binary_ok = dir
        .read_dir()
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            path.file_name().and_then(|name| name.to_str()) != Some(".pin")
                && !is_symlink(&path)
                && entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
        });
    if !binary_ok {
        return false;
    }
    let text = std::fs::read_to_string(dir.join(".pin")).unwrap_or_default();
    let mut lines = text.lines();
    lines.next() == Some(version) && lines.next().is_some_and(|line| same_hash(line, sha256))
}

fn write_program(
    dir: &Path,
    binary_name: &str,
    bytes: &[u8],
    version: &str,
    sha256: &str,
) -> Result<(), EnsureError> {
    if is_symlink(dir) {
        return Err(EnsureError::Refused(
            "The tools folder is a link, so it was refused.".into(),
        ));
    }
    let binary = dir.join(binary_name);
    if binary.parent() != Some(dir) {
        return Err(EnsureError::Refused(
            "Refusing to write outside the tools folder.".into(),
        ));
    }
    let part = dir.join(format!(".{binary_name}.part"));
    std::fs::write(&part, bytes).map_err(|error| {
        EnsureError::Unavailable(format!("The program couldn't be written ({error})."))
    })?;
    if let Err(error) = set_mode(&part) {
        let _ = std::fs::remove_file(&part);
        return Err(error);
    }
    std::fs::rename(&part, &binary).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        EnsureError::Unavailable(format!("The program couldn't be written ({error})."))
    })?;
    let pin = format!("{version}\n{sha256}\n");
    std::fs::write(dir.join(".pin"), pin).map_err(|error| {
        EnsureError::Unavailable(format!("The program couldn't be written ({error})."))
    })?;
    Ok(())
}

/// Install `pin` under `<data_dir>/tools/<name>/<version>/` when the pin is
/// complete. A matching `.pin` skips the download. On every refusal the
/// destination is left as it was.
pub fn ensure(
    data_dir: &Path,
    pin: &ToolPin,
    source: &dyn BlobSource,
) -> Result<Installed, EnsureError> {
    let asset = asset_for(pin)?;
    if is_symlink(data_dir) {
        return Err(EnsureError::Refused(
            "The data folder is a link, so the tool was refused.".into(),
        ));
    }
    let tools = data_dir.join("tools").join(pin.name);
    let dest = tools.join(pin.version);
    if is_symlink(&tools) || is_symlink(&dest) {
        return Err(EnsureError::Refused(
            "The tools folder is a link, so it was refused.".into(),
        ));
    }
    if dest.is_dir() && marker_matches(&dest, pin.version, asset.sha256) {
        let binary = dest.join(asset.binary_name);
        if binary.is_file() && !is_symlink(&binary) {
            return Ok(Installed {
                binary,
                fetched: false,
            });
        }
    }
    let _lock = InstallLock::acquire(&tools)?;
    if dest.is_dir() && marker_matches(&dest, pin.version, asset.sha256) {
        let binary = dest.join(asset.binary_name);
        if binary.is_file() && !is_symlink(&binary) {
            return Ok(Installed {
                binary,
                fetched: false,
            });
        }
    }
    let bytes = source.fetch(asset.url).map_err(EnsureError::Unavailable)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(EnsureError::Refused(
            "The download is larger than 64MB, so it was refused.".into(),
        ));
    }
    if !same_hash(&sha256_hex(&bytes), asset.sha256) {
        return Err(EnsureError::ChecksumMismatch);
    }
    let program = extract(&bytes, asset.archive, asset.binary_name)?;
    let staging = tools.join(format!(
        ".{}.staging-{}-{}",
        pin.version,
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if staging.parent() != Some(tools.as_path()) {
        return Err(EnsureError::Refused(
            "Refusing to write outside the tools folder.".into(),
        ));
    }
    std::fs::create_dir_all(&staging).map_err(|error| {
        EnsureError::Unavailable(format!("The tools folder couldn't be created ({error})."))
    })?;
    let wrote = write_program(
        &staging,
        asset.binary_name,
        &program,
        pin.version,
        asset.sha256,
    );
    if let Err(error) = wrote {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if dest.exists() {
        let old = tools.join(format!(".{}.previous-{}", pin.version, std::process::id()));
        if std::fs::rename(&dest, &old).is_err() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(EnsureError::Unavailable(
                "The previous install couldn't be moved aside.".into(),
            ));
        }
        if std::fs::rename(&staging, &dest).is_err() {
            let _ = std::fs::rename(&old, &dest);
            let _ = std::fs::remove_dir_all(&staging);
            return Err(EnsureError::Unavailable(
                "The program couldn't be written.".into(),
            ));
        }
        let _ = std::fs::remove_dir_all(&old);
    } else if let Err(error) = std::fs::rename(&staging, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(EnsureError::Unavailable(format!(
            "The program couldn't be written ({error})."
        )));
    }
    let binary = dest.join(asset.binary_name);
    if !binary.is_file() || is_symlink(&binary) {
        return Err(EnsureError::Refused(
            "The program didn't land inside the tools folder, so it was refused.".into(),
        ));
    }
    Ok(Installed {
        binary,
        fetched: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Bytes {
        body: Vec<u8>,
        calls: AtomicUsize,
        fail: bool,
    }

    impl BlobSource for Bytes {
        fn fetch(&self, _url: &str) -> Result<Vec<u8>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err("offline".into());
            }
            Ok(self.body.clone())
        }
    }

    fn pin(sha: &str, kind: ArchiveKind, binary: &'static str) -> (ToolPin, String) {
        let sha = sha.to_string();
        // Leak the checksum so the pin can hold a &'static str in tests.
        let sha_static: &'static str = Box::leak(sha.into_boxed_str());
        let (os, arch) = this_platform();
        let os: &'static str = Box::leak(os.to_string().into_boxed_str());
        let arch: &'static str = Box::leak(arch.to_string().into_boxed_str());
        (
            ToolPin {
                name: "example-tool",
                version: "1.2.3",
                assets: Box::leak(Box::new([ToolAsset {
                    os,
                    arch,
                    url: "https://example.invalid/tool",
                    sha256: sha_static,
                    archive: kind,
                    binary_name: binary,
                }])),
            },
            sha_static.to_string(),
        )
    }

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut raw = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut raw);
            for (name, bytes) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *bytes).unwrap();
            }
            builder.finish().unwrap();
        }
        gzip(&raw)
    }

    /// A ustar whose names the `tar` crate refuses to write, such as `../treehouse`.
    fn tar_gz_raw(files: &[(&str, &[u8])]) -> Vec<u8> {
        fn octal(field: &mut [u8], value: u64) {
            let text = format!("{value:o}");
            assert!(text.len() < field.len(), "octal field too small");
            field[..text.len()].copy_from_slice(text.as_bytes());
            field[text.len()] = 0;
        }
        let mut raw = Vec::new();
        for (name, bytes) in files {
            assert!(name.len() < 100 && !name.is_empty());
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            octal(&mut header[100..108], 0o644);
            octal(&mut header[108..116], 0);
            octal(&mut header[116..124], 0);
            octal(&mut header[124..136], bytes.len() as u64);
            octal(&mut header[136..148], 0);
            header[156] = b'0';
            header[257..262].copy_from_slice(b"ustar");
            header[263..265].copy_from_slice(b"00");
            header[148..156].fill(b' ');
            let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
            let sum_text = format!("{sum:06o}\0 ");
            header[148..156].copy_from_slice(sum_text.as_bytes());
            raw.extend_from_slice(&header);
            raw.extend_from_slice(bytes);
            let pad = (512 - (bytes.len() % 512)) % 512;
            raw.extend(std::iter::repeat_n(0u8, pad));
        }
        raw.extend(std::iter::repeat_n(0u8, 1024));
        gzip(&raw)
    }

    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(raw).unwrap();
        gz.finish().unwrap()
    }

    fn tar_symlink(name: &str, target: &str) -> Vec<u8> {
        let mut raw = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut raw);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_cksum();
            builder.append_link(&mut header, name, target).unwrap();
            builder.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        gz.finish().unwrap()
    }

    struct ZipEntry {
        name: String,
        data: Vec<u8>,
        method: u16,
    }

    fn zip_store(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let entries: Vec<ZipEntry> = entries
            .iter()
            .map(|(name, data)| ZipEntry {
                name: (*name).to_string(),
                data: data.to_vec(),
                method: 0,
            })
            .collect();
        zip_entries(&entries)
    }

    fn zip_entries(entries: &[ZipEntry]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for entry in entries {
            let local_at = out.len() as u32;
            let name = entry.name.as_bytes();
            let payload = if entry.method == 8 {
                let mut enc =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                enc.write_all(&entry.data).unwrap();
                enc.finish().unwrap()
            } else {
                entry.data.clone()
            };
            out.extend_from_slice(&0x04034b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&entry.method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name);
            out.extend_from_slice(&payload);

            central.extend_from_slice(&0x02014b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&entry.method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&local_at.to_le_bytes());
            central.extend_from_slice(name);
        }
        let cd_at = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x06054b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_at.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    fn temp_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "pinned-tool-{}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn checksum_mismatch_writes_nothing() {
        let dir = Tmp(temp_dir());
        let archive = tar_gz(&[("treehouse", b"program")]);
        let (pin, _) = pin(&"ab".repeat(32), ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: archive,
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::ChecksumMismatch));
        assert!(source.calls.load(Ordering::SeqCst) == 1);
        let tools = dir.0.join("tools");
        assert!(
            !tools.exists()
                || std::fs::read_dir(&tools).unwrap().next().is_none()
                || !dir.0.join("tools/example-tool/1.2.3").exists()
        );
        assert!(!dir.0.join("tools/example-tool/1.2.3/treehouse").exists());
    }

    #[test]
    fn unset_checksum_does_not_fetch_or_write() {
        let dir = Tmp(temp_dir());
        let (pin, _) = pin("", ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: Vec::new(),
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::NotPinned(_)));
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
        assert!(!dir.0.join("tools").exists());
    }

    #[test]
    fn unavailable_fetch_writes_nothing_and_is_not_success() {
        let dir = Tmp(temp_dir());
        let (pin, _) = pin(&"cd".repeat(32), ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: Vec::new(),
            calls: AtomicUsize::new(0),
            fail: true,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::Unavailable(_)));
        assert!(!dir.0.join("tools/example-tool/1.2.3").exists());
    }

    #[test]
    fn tar_installs_only_the_named_program_and_a_second_call_does_not_fetch() {
        let dir = Tmp(temp_dir());
        let archive = tar_gz(&[
            ("treehouse", b"#!/bin/true\n"),
            ("install.sh", b"echo no\n"),
            ("README", b"hi\n"),
        ]);
        let sum = sha256_hex(&archive);
        let (pin, _) = pin(&sum, ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: archive,
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let installed = ensure(&dir.0, &pin, &source).unwrap();
        assert!(installed.fetched);
        assert_eq!(std::fs::read(&installed.binary).unwrap(), b"#!/bin/true\n");
        let version = dir.0.join("tools/example-tool/1.2.3");
        assert!(!version.join("install.sh").exists());
        assert!(!version.join("README").exists());
        let names: Vec<_> = std::fs::read_dir(&version)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"treehouse".to_string()));
        assert!(names.contains(&".pin".to_string()));
        assert_eq!(names.len(), 2);
        let again = ensure(&dir.0, &pin, &source).unwrap();
        assert!(!again.fetched);
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_path_that_leaves_the_archive_is_refused() {
        let dir = Tmp(temp_dir());
        let archive = tar_gz_raw(&[("../treehouse", b"nope"), ("treehouse", b"ok")]);
        let sum = sha256_hex(&archive);
        let (pin, _) = pin(&sum, ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: archive,
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::Refused(_)), "{error}");
        assert!(!dir.0.join("tools/example-tool/1.2.3/treehouse").exists());
        assert!(!dir.0.join("treehouse").exists());
    }

    #[test]
    fn a_symlink_program_is_refused() {
        let dir = Tmp(temp_dir());
        let archive = tar_symlink("treehouse", "install.sh");
        let sum = sha256_hex(&archive);
        let (pin, _) = pin(&sum, ArchiveKind::TarGz, "treehouse");
        let source = Bytes {
            body: archive,
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::Refused(_)), "{error}");
        assert!(!dir.0.join("tools/example-tool/1.2.3/treehouse").exists());
    }

    #[test]
    fn zip_installs_only_the_named_program() {
        let dir = Tmp(temp_dir());
        let archive = zip_store(&[("treehouse.exe", b"MZ"), ("install.ps1", b"no")]);
        let sum = sha256_hex(&archive);
        let (pin, _) = pin(&sum, ArchiveKind::Zip, "treehouse.exe");
        let source = Bytes {
            body: archive,
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let installed = ensure(&dir.0, &pin, &source).unwrap();
        assert_eq!(std::fs::read(installed.binary).unwrap(), b"MZ");
        let version = dir.0.join("tools/example-tool/1.2.3");
        assert!(!version.join("install.ps1").exists());
    }

    #[test]
    fn zip_deflate_round_trip() {
        let archive = zip_entries(&[ZipEntry {
            name: "treehouse.exe".into(),
            data: b"hello zip".to_vec(),
            method: 8,
        }]);
        let got = extract_zip(&archive, "treehouse.exe").unwrap();
        assert_eq!(got, b"hello zip");
    }

    #[test]
    fn zip_path_escape_is_refused() {
        let archive = zip_store(&[("..\\treehouse.exe", b"no"), ("ok", b"x")]);
        let error = extract_zip(&archive, "treehouse.exe").unwrap_err();
        assert!(matches!(error, EnsureError::Refused(_)), "{error}");
    }

    #[test]
    fn zip_declared_size_over_the_cap_is_refused_without_a_huge_file() {
        let mut archive = zip_store(&[("treehouse.exe", b"tiny")]);
        // Central-directory uncompressed size sits just before the name length
        // of the single entry. Patch it to one past the cap.
        let eocd = find_eocd(&archive).unwrap();
        let cd_at = read_u32(&archive, eocd + 16).unwrap() as usize;
        let too_big = (MAX_BYTES as u32).saturating_add(1);
        archive[cd_at + 24..cd_at + 28].copy_from_slice(&too_big.to_le_bytes());
        let error = extract_zip(&archive, "treehouse.exe").unwrap_err();
        assert!(matches!(error, EnsureError::Refused(_)), "{error}");
    }

    #[test]
    fn a_bad_tool_name_is_not_pinned() {
        let dir = Tmp(temp_dir());
        let (mut pin, _) = pin(&"ab".repeat(32), ArchiveKind::TarGz, "treehouse");
        pin.name = "../tools";
        let source = Bytes {
            body: Vec::new(),
            calls: AtomicUsize::new(0),
            fail: false,
        };
        let error = ensure(&dir.0, &pin, &source).unwrap_err();
        assert!(matches!(error, EnsureError::NotPinned(_)));
        assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    }
}
