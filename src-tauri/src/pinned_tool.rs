//! One download-and-verify helper for any tool pinned to an exact version (Hivra WP-81 and WP-82).
//!
//! A [`Pin`] is the whole contract: the tool's name, its exact version, one asset per platform
//! (archive file name and sha256), and which binary to take out of that archive. [`install`] checks
//! the archive before it writes anything, keeps only that one binary in
//! `<data>/tools/<name>/<version>/`, and never runs an install script. WP-82 calls [`install`] with
//! its own `Pin`; nothing here is special to no-mistakes except the `NO_MISTAKES` constant.
//!
//! A version bump is a reviewed commit that changes both the version and the checksums. An empty or
//! non-64-hex checksum is not a pin: install refuses and does not download.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::Digest;

const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;

/// One platform's release asset. `sha256` is the archive's SHA-256, lowercase hex. Empty means the
/// pin is not set yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asset {
    pub os: &'static str,
    pub arch: &'static str,
    pub file_name: &'static str,
    pub sha256: &'static str,
}

/// Any tool Hivra may download. `url_base` ends with `/` and the asset's file name is appended.
/// `binary` is the one file kept from the archive; [`binary_file_name`] adds `.exe` on Windows.
/// Other files in the archive, including install scripts, are not written.
#[derive(Clone, Copy, Debug)]
pub struct Pin {
    pub name: &'static str,
    pub version: &'static str,
    pub url_base: &'static str,
    pub binary: &'static str,
    pub assets: &'static [Asset],
}

/// no-mistakes 1.111.0. The sha256 values are that release's `checksums.txt`. The darwin-arm64
/// value was checked against the downloaded tarball. 1.110.0 is the first release whose
/// `axi run` accepts `--pr-title` and `--pr-body-file`, which the delivery gate passes (1.106.1,
/// the last release not marked pre-release, rejects them as unknown flags). Do not pin older. Asset names follow no-mistakes
/// `releaseArchiveName`: `{app}-{tag}-{GOOS}-{GOARCH}`, `.tar.gz` except Windows `.zip`.
/// The archive holds one file, `no-mistakes` (`no-mistakes.exe` on Windows).
pub const NO_MISTAKES: Pin = Pin {
    name: "no-mistakes",
    version: "1.111.0",
    url_base: "https://github.com/kunchenguid/no-mistakes/releases/download/v1.111.0/",
    binary: "no-mistakes",
    assets: &[
        Asset {
            os: "darwin",
            arch: "arm64",
            file_name: "no-mistakes-v1.111.0-darwin-arm64.tar.gz",
            sha256: "3d9e6466d74dd487ac915baf5cfc22fec697c15e6cbce9f5bf711b7549ad7522",
        },
        Asset {
            os: "darwin",
            arch: "amd64",
            file_name: "no-mistakes-v1.111.0-darwin-amd64.tar.gz",
            sha256: "bf56b46722d2afbb973fe584241568cb8958c39b6e92e2daf064bc3158f4ef0a",
        },
        Asset {
            os: "linux",
            arch: "arm64",
            file_name: "no-mistakes-v1.111.0-linux-arm64.tar.gz",
            sha256: "c6726b73e7016b63b76304fd3ce559cfdf657e5dbfe6d29884fc081abdc23517",
        },
        Asset {
            os: "linux",
            arch: "amd64",
            file_name: "no-mistakes-v1.111.0-linux-amd64.tar.gz",
            sha256: "61022147dece3ceb3936a6ef5538e6ac841b0be4a7080c039627238ae92da7ac",
        },
        Asset {
            os: "windows",
            arch: "arm64",
            file_name: "no-mistakes-v1.111.0-windows-arm64.zip",
            sha256: "48da2b2c6ef8dd14e7f09e3b40a6d2039c5b57bb5e7d7efb82a5a462fa922bc1",
        },
        Asset {
            os: "windows",
            arch: "amd64",
            file_name: "no-mistakes-v1.111.0-windows-amd64.zip",
            sha256: "2078649e00358de921234e622f8572a2deead413fbdae09499c56dbb65e1d51b",
        },
    ],
};

pub fn host_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
}

impl Pin {
    pub fn asset(self, os: &str, arch: &str) -> Option<&'static Asset> {
        self.assets
            .iter()
            .find(|asset| asset.os == os && asset.arch == arch)
    }
}

pub trait Fetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// The real download. A timeout or a service that does not answer is not a final failure.
pub struct UreqFetcher;

impl Fetcher for UreqFetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let response = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .build()
            .get(url)
            .call()
            .map_err(|_| "The download didn't finish. Try again.".to_string())?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_ARCHIVE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "The download didn't finish. Try again.".to_string())?;
        if bytes.len() as u64 > MAX_ARCHIVE {
            return Err("The download is larger than Hivra will keep, so it was refused.".into());
        }
        Ok(bytes)
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn same_hash(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected)
}

/// `no-mistakes` on macOS and Linux, `no-mistakes.exe` on Windows.
pub fn binary_file_name(binary: &str, os: &str) -> String {
    if os == "windows" {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    }
}

fn pin_not_set(pin: &Pin, os: &str, arch: &str) -> String {
    format!(
        "The pin for {} {} ({os}-{arch}) isn't set, so it was not installed.",
        pin.name, pin.version
    )
}

/// Install `pin` for `os`/`arch` into `<data_dir>/tools/<name>/<version>/`. A matching copy already
/// there is kept and not downloaded again. A checksum mismatch writes nothing.
pub fn install(
    pin: &Pin,
    data_dir: &Path,
    os: &str,
    arch: &str,
    fetcher: &dyn Fetcher,
) -> Result<PathBuf, String> {
    let asset = pin.asset(os, arch).ok_or_else(|| {
        format!(
            "There is no {} {} build for {os}-{arch}.",
            pin.name, pin.version
        )
    })?;
    if asset.sha256.is_empty() || !hex64(asset.sha256) {
        return Err(pin_not_set(pin, os, arch));
    }
    let dest = tools_dir(data_dir, pin.name, pin.version)?;
    let binary_name = binary_file_name(pin.binary, os);
    let binary_path = dest.join(&binary_name);
    if binary_path.parent() != Some(dest.as_path()) {
        return Err("Refusing to write outside the tools folder.".into());
    }
    if installed_matches(&dest, &binary_path, asset.sha256) {
        return Ok(binary_path);
    }
    let url = format!("{}{}", pin.url_base, asset.file_name);
    let bytes = fetcher.fetch(&url)?;
    let actual = sha256_hex(&bytes);
    if !same_hash(&actual, asset.sha256) {
        return Err("The download doesn't match the pin, so it was refused.".into());
    }
    let extracted = extract_binary(asset.file_name, &bytes, &binary_name)?;
    write_binary(&dest, &binary_name, &extracted, asset.sha256)?;
    Ok(binary_path)
}

fn installed_matches(dest: &Path, binary: &Path, archive_sha: &str) -> bool {
    let record = match std::fs::read_to_string(dest.join("installed.sha256")) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let mut lines = record.lines();
    let archived = lines.next().unwrap_or("").trim();
    let binary_sha = lines.next().unwrap_or("").trim();
    if !same_hash(archived, archive_sha) || !hex64(binary_sha) {
        return false;
    }
    match std::fs::read(binary) {
        Ok(bytes) => same_hash(&sha256_hex(&bytes), binary_sha),
        Err(_) => false,
    }
}

fn tools_dir(data_dir: &Path, name: &str, version: &str) -> Result<PathBuf, String> {
    if !segment_ok(name) || !segment_ok(version) {
        return Err("The pin's name isn't usable.".into());
    }
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let root = crate::fs::canonical(data_dir).map_err(|e| e.to_string())?;
    let tools = root.join("tools").join(name).join(version);
    std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let tools = crate::fs::canonical(&tools).map_err(|e| e.to_string())?;
    if !tools.starts_with(&root) {
        return Err("Refusing to write outside the tools folder.".into());
    }
    let meta = std::fs::symlink_metadata(&tools).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("The tools folder is a link, so it was refused.".into());
    }
    Ok(tools)
}

fn segment_ok(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['/', '\\', '\0'])
        && value != "."
        && value != ".."
        && !value.contains("..")
}

fn leaves_archive(path: &Path) -> bool {
    path.components()
        .filter(|component| !matches!(component, Component::CurDir))
        .any(|component| !matches!(component, Component::Normal(_)))
}

fn file_name_of(path: &Path) -> Option<&str> {
    path.file_name().and_then(|name| name.to_str())
}

fn extract_binary(archive_name: &str, bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    let files = if archive_name.ends_with(".tar.gz") {
        read_tar_gz(bytes)?
    } else if archive_name.ends_with(".zip") {
        read_zip(bytes)?
    } else {
        return Err("This pin's archive isn't one Hivra can unpack, so it was refused.".into());
    };
    let mut found: Option<Vec<u8>> = None;
    for (path, data) in files {
        if leaves_archive(&path) {
            return Err(
                "The download holds a path that leaves its folder, so it was refused.".into(),
            );
        }
        if file_name_of(&path) != Some(binary_name) {
            continue;
        }
        if found.is_some() {
            return Err(format!(
                "The download has more than one {binary_name}, so it was refused."
            ));
        }
        found = Some(data);
    }
    found.ok_or_else(|| format!("The download has no {binary_name}, so it was refused."))
}

fn read_tar_gz(bytes: &[u8]) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
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
            return Err(
                "The download holds a path that leaves its folder, so it was refused.".into(),
            );
        }
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?;
        files.push((path, buf));
    }
    Ok(files)
}

fn read_zip(bytes: &[u8]) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut files = Vec::new();
    let mut offset = 0;
    while offset + 30 <= bytes.len() {
        if bytes[offset..offset + 4] != [0x50, 0x4b, 0x03, 0x04] {
            break;
        }
        let flags = u16::from_le_bytes([bytes[offset + 6], bytes[offset + 7]]);
        let method = u16::from_le_bytes([bytes[offset + 8], bytes[offset + 9]]);
        let compressed =
            u32::from_le_bytes(bytes[offset + 18..offset + 22].try_into().unwrap()) as usize;
        let name_len = u16::from_le_bytes([bytes[offset + 26], bytes[offset + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let name_at = offset + 30;
        let data_at = name_at + name_len + extra_len;
        if name_at + name_len > bytes.len() || data_at + compressed > bytes.len() {
            return Err("The download can't be unpacked, so it was refused.".into());
        }
        if flags & 0x1 != 0 {
            return Err("The download is encrypted, so it was refused.".into());
        }
        // Bit 3 stores sizes after the data. Release zips we pin put the sizes in the header.
        if flags & 0x8 != 0 && compressed == 0 {
            return Err("The download can't be unpacked, so it was refused.".into());
        }
        let name = std::str::from_utf8(&bytes[name_at..name_at + name_len])
            .map_err(|_| "The download can't be unpacked, so it was refused.".to_string())?;
        let path = PathBuf::from(name.replace('\\', "/"));
        if leaves_archive(&path) {
            return Err(
                "The download holds a path that leaves its folder, so it was refused.".into(),
            );
        }
        let raw = &bytes[data_at..data_at + compressed];
        if !name.ends_with('/') {
            let data = match method {
                0 => raw.to_vec(),
                8 => {
                    let mut decoded = Vec::new();
                    flate2::read::DeflateDecoder::new(raw)
                        .read_to_end(&mut decoded)
                        .map_err(|_| {
                            "The download can't be unpacked, so it was refused.".to_string()
                        })?;
                    decoded
                }
                _ => {
                    return Err("The download can't be unpacked, so it was refused.".into());
                }
            };
            files.push((path, data));
        }
        offset = data_at + compressed;
    }
    Ok(files)
}

fn write_binary(dest: &Path, name: &str, bytes: &[u8], archive_sha: &str) -> Result<(), String> {
    if name.contains(['/', '\\', '\0']) || name == ".." || name.is_empty() {
        return Err("The tool's file name isn't usable.".into());
    }
    let path = dest.join(name);
    let part = dest.join(format!(".{name}.part"));
    if path.parent() != Some(dest) || part.parent() != Some(dest) {
        return Err("Refusing to write outside the tools folder.".into());
    }
    let write = (|| {
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        set_mode(&part)?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
        let record = format!(
            "{}\n{}\n",
            archive_sha.to_ascii_lowercase(),
            sha256_hex(bytes)
        );
        let record_path = dest.join("installed.sha256");
        if record_path.parent() != Some(dest) {
            return Err("Refusing to write outside the tools folder.".into());
        }
        std::fs::write(&record_path, record).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if write.is_err() && part.parent() == Some(dest) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountFetcher {
        hits: AtomicUsize,
        body: Vec<u8>,
    }

    impl Fetcher for CountFetcher {
        fn fetch(&self, _url: &str) -> Result<Vec<u8>, String> {
            self.hits.fetch_add(1, Ordering::SeqCst);
            Ok(self.body.clone())
        }
    }

    struct Temp(PathBuf);

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp() -> Temp {
        let dir = std::env::temp_dir().join(format!("hivra-pin-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Temp(dir)
    }

    fn leak(value: String) -> &'static str {
        Box::leak(value.into_boxed_str())
    }

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, *name, *data).unwrap();
        }
        let raw = builder.into_inner().unwrap();
        gzip(&raw)
    }

    /// A tar the `tar` builder refuses to write, so a `..` name can still be tested.
    fn raw_tar_gz(name: &str, data: &[u8]) -> Vec<u8> {
        let mut header = [0u8; 512];
        let name_bytes = name.as_bytes();
        assert!(name_bytes.len() < 100);
        header[..name_bytes.len()].copy_from_slice(name_bytes);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        let size = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0';
        header[257..262].copy_from_slice(b"ustar");
        header[263..265].copy_from_slice(b"00");
        let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        let cksum = format!("{sum:06o}\0 ");
        header[148..156].copy_from_slice(cksum.as_bytes());
        let mut raw = Vec::new();
        raw.extend_from_slice(&header);
        raw.extend_from_slice(data);
        let pad = (512 - (data.len() % 512)) % 512;
        raw.extend(std::iter::repeat_n(0, pad));
        raw.extend(std::iter::repeat_n(0, 1024));
        gzip(&raw)
    }

    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(raw).unwrap();
        enc.finish().unwrap()
    }

    fn stored_zip(name: &str, data: &[u8]) -> Vec<u8> {
        let name_bytes = name.as_bytes();
        let mut out = Vec::new();
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);
        out
    }

    fn deflate_zip(name: &str, data: &[u8]) -> Vec<u8> {
        let mut enc =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        let compressed = enc.finish().unwrap();
        let name_bytes = name.as_bytes();
        let mut out = Vec::new();
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(&compressed);
        out
    }

    fn pin_for(file_name: &'static str, sha: &str, os: &'static str) -> Pin {
        let sha = leak(sha.to_string());
        let asset: &'static Asset = Box::leak(Box::new(Asset {
            os,
            arch: "arm64",
            file_name,
            sha256: sha,
        }));
        Pin {
            name: "sample",
            version: "1.0.0",
            url_base: "https://example.invalid/sample/",
            binary: "sample",
            assets: std::slice::from_ref(asset),
        }
    }

    #[test]
    fn a_checksum_mismatch_writes_nothing() {
        let dir = temp();
        let archive = tar_gz(&[("sample", b"tool-bytes")]);
        let pin = pin_for(
            "sample-v1.0.0-darwin-arm64.tar.gz",
            &"ab".repeat(32),
            "darwin",
        );
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let err = install(&pin, &dir.0, "darwin", "arm64", &fetcher).unwrap_err();
        assert!(err.contains("doesn't match the pin"), "{err}");
        assert_eq!(fetcher.hits.load(Ordering::SeqCst), 1);
        let tools = dir.0.join("tools").join("sample").join("1.0.0");
        assert!(!tools.join("sample").exists());
        assert!(!tools.join("installed.sha256").exists());
    }

    #[test]
    fn a_matching_archive_installs_and_a_second_call_does_not_fetch() {
        let dir = temp();
        let archive = tar_gz(&[("sample", b"tool-bytes"), ("install.sh", b"echo no")]);
        let sha = sha256_hex(&archive);
        let pin = pin_for("sample-v1.0.0-darwin-arm64.tar.gz", &sha, "darwin");
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let path = install(&pin, &dir.0, "darwin", "arm64", &fetcher).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"tool-bytes");
        assert!(!path.parent().unwrap().join("install.sh").exists());
        let again = install(&pin, &dir.0, "darwin", "arm64", &fetcher).unwrap();
        assert_eq!(again, path);
        assert_eq!(fetcher.hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_path_that_leaves_the_archive_is_refused() {
        let dir = temp();
        let archive = raw_tar_gz("../sample", b"tool-bytes");
        let sha = sha256_hex(&archive);
        let pin = pin_for("sample-v1.0.0-darwin-arm64.tar.gz", &sha, "darwin");
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let err = install(&pin, &dir.0, "darwin", "arm64", &fetcher).unwrap_err();
        assert!(err.contains("leaves its folder"), "{err}");
        assert!(!dir
            .0
            .join("tools")
            .join("sample")
            .join("1.0.0")
            .join("sample")
            .exists());
    }

    #[test]
    fn an_unset_pin_refuses_without_downloading() {
        let dir = temp();
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: Vec::new(),
        };
        let pin = pin_for("sample-v1.0.0-darwin-arm64.tar.gz", "", "darwin");
        let err = install(&pin, &dir.0, "darwin", "arm64", &fetcher).unwrap_err();
        assert!(err.contains("isn't set"), "{err}");
        assert_eq!(fetcher.hits.load(Ordering::SeqCst), 0);
        assert!(!dir.0.join("tools").exists());
    }

    /// The delivery gate runs `axi run --pr-title ... --pr-body-file ...`. no-mistakes 1.106.1
    /// rejects both as unknown flags (checked against the real binary), 1.110.0 added them.
    /// A pin older than that makes every real delivery run fail on its first command.
    #[test]
    fn the_pin_is_new_enough_for_the_flags_the_gate_passes() {
        let parts: Vec<u32> = NO_MISTAKES
            .version
            .split('.')
            .map(|p| p.parse().expect("numeric version part"))
            .collect();
        assert!(
            parts.as_slice() >= [1, 110, 0].as_slice(),
            "no-mistakes {} predates --pr-title and --pr-body-file",
            NO_MISTAKES.version
        );
    }

    #[test]
    fn every_platform_has_a_pinned_asset() {
        let want = [
            (
                "darwin",
                "arm64",
                "no-mistakes-v1.111.0-darwin-arm64.tar.gz",
                "3d9e6466d74dd487ac915baf5cfc22fec697c15e6cbce9f5bf711b7549ad7522",
            ),
            (
                "darwin",
                "amd64",
                "no-mistakes-v1.111.0-darwin-amd64.tar.gz",
                "bf56b46722d2afbb973fe584241568cb8958c39b6e92e2daf064bc3158f4ef0a",
            ),
            (
                "linux",
                "arm64",
                "no-mistakes-v1.111.0-linux-arm64.tar.gz",
                "c6726b73e7016b63b76304fd3ce559cfdf657e5dbfe6d29884fc081abdc23517",
            ),
            (
                "linux",
                "amd64",
                "no-mistakes-v1.111.0-linux-amd64.tar.gz",
                "61022147dece3ceb3936a6ef5538e6ac841b0be4a7080c039627238ae92da7ac",
            ),
            (
                "windows",
                "arm64",
                "no-mistakes-v1.111.0-windows-arm64.zip",
                "48da2b2c6ef8dd14e7f09e3b40a6d2039c5b57bb5e7d7efb82a5a462fa922bc1",
            ),
            (
                "windows",
                "amd64",
                "no-mistakes-v1.111.0-windows-amd64.zip",
                "2078649e00358de921234e622f8572a2deead413fbdae09499c56dbb65e1d51b",
            ),
        ];
        assert_eq!(NO_MISTAKES.version, "1.111.0");
        assert_eq!(NO_MISTAKES.binary, "no-mistakes");
        assert!(NO_MISTAKES.url_base.ends_with("/v1.111.0/"));
        assert_eq!(NO_MISTAKES.assets.len(), want.len());
        for (os, arch, file, sha) in want {
            let asset = NO_MISTAKES
                .asset(os, arch)
                .unwrap_or_else(|| panic!("missing {os}-{arch}"));
            assert_eq!(asset.file_name, file);
            assert_eq!(asset.sha256, sha);
            assert!(hex64(asset.sha256));
            let binary = binary_file_name(NO_MISTAKES.binary, os);
            if os == "windows" {
                assert!(binary.ends_with(".exe"));
            } else {
                assert_eq!(binary, "no-mistakes");
            }
        }
    }

    #[test]
    fn a_windows_zip_installs_the_exe_and_not_a_script() {
        let dir = temp();
        let archive = stored_zip("no-mistakes.exe", b"win-bytes");
        let sha = leak(sha256_hex(&archive));
        let asset: &'static Asset = Box::leak(Box::new(Asset {
            os: "windows",
            arch: "amd64",
            file_name: "no-mistakes-v1.111.0-windows-amd64.zip",
            sha256: sha,
        }));
        let pin = Pin {
            name: "no-mistakes",
            version: "1.111.0",
            url_base: "https://example.invalid/",
            binary: "no-mistakes",
            assets: std::slice::from_ref(asset),
        };
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let path = install(&pin, &dir.0, "windows", "amd64", &fetcher).unwrap();
        assert!(path.ends_with("no-mistakes.exe"));
        assert_eq!(std::fs::read(&path).unwrap(), b"win-bytes");
    }

    #[test]
    fn a_deflated_zip_is_unpacked() {
        let dir = temp();
        let archive = deflate_zip("sample.exe", b"deflated-bytes");
        let sha = sha256_hex(&archive);
        let pin = pin_for("sample-v1.0.0-windows-arm64.zip", &sha, "windows");
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let path = install(&pin, &dir.0, "windows", "arm64", &fetcher).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"deflated-bytes");
    }

    #[test]
    fn a_zip_path_that_leaves_the_archive_is_refused() {
        let dir = temp();
        let archive = stored_zip("../sample.exe", b"nope");
        let sha = sha256_hex(&archive);
        let asset: &'static Asset = Box::leak(Box::new(Asset {
            os: "windows",
            arch: "amd64",
            file_name: "sample-v1.0.0-windows-amd64.zip",
            sha256: leak(sha),
        }));
        let pin = Pin {
            name: "sample",
            version: "1.0.0",
            url_base: "https://example.invalid/",
            binary: "sample",
            assets: std::slice::from_ref(asset),
        };
        let fetcher = CountFetcher {
            hits: AtomicUsize::new(0),
            body: archive,
        };
        let err = install(&pin, &dir.0, "windows", "amd64", &fetcher).unwrap_err();
        assert!(err.contains("leaves its folder"), "{err}");
    }
}
