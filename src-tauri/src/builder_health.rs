// WP-161: one health sample for the builder pause.
// Syscalls and one fixed file, never a shell and never a path from outside this module.
// A missing field is left out. A timed-out disk read is a missing field, not a pause.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_MS: i64 = 4_000;
const KEEP_GOOD_MS: i64 = 15_000;
const DISK_TIMEOUT: Duration = Duration::from_secs(2);
const GB: f64 = 1_073_741_824.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderHealth {
    pub load1: Option<f64>,
    pub cores: Option<u32>,
    pub free_memory_gb: Option<f64>,
    pub free_disk_gb: Option<f64>,
    /// When this sample was taken, epoch ms. The web gate ignores one older than 15s.
    pub read_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
struct Reading {
    load1: Option<f64>,
    cores: Option<u32>,
    free_memory_gb: Option<f64>,
    free_disk_gb: Option<f64>,
}

struct Held {
    reading: Reading,
    taken_at: i64,
    next_try: i64,
}

fn empty_reading() -> Reading {
    Reading {
        load1: None,
        cores: None,
        free_memory_gb: None,
        free_disk_gb: None,
    }
}

fn round3(n: f64) -> Option<f64> {
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    Some((n * 1000.0).round() / 1000.0)
}

fn bytes_to_gb(bytes: u128) -> Option<f64> {
    round3(bytes as f64 / GB)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Serves a sample for 4s. A failed read keeps a sample under 15s old and does not become the cache.
fn recall(
    held: &mut Option<Held>,
    now: i64,
    read: impl FnOnce() -> Result<Reading, ()>,
) -> Reading {
    if let Some(slot) = held.as_ref() {
        if now < slot.next_try {
            return slot.reading.clone();
        }
    }
    match read() {
        Ok(reading) => {
            *held = Some(Held {
                reading: reading.clone(),
                taken_at: now,
                next_try: now.saturating_add(CACHE_MS),
            });
            reading
        }
        Err(()) => {
            if let Some(slot) = held.as_mut() {
                if now.saturating_sub(slot.taken_at) <= KEEP_GOOD_MS {
                    slot.next_try = now.saturating_add(CACHE_MS);
                    return slot.reading.clone();
                }
            }
            let reading = empty_reading();
            *held = Some(Held {
                reading: reading.clone(),
                taken_at: now,
                next_try: now.saturating_add(CACHE_MS),
            });
            reading
        }
    }
}

fn taken_at(held: &Option<Held>, now: i64) -> i64 {
    held.as_ref().map(|slot| slot.taken_at).unwrap_or(now)
}

fn within<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("builder-health".into())
        .spawn(move || {
            let _ = tx.send(work());
        });
    if spawned.is_err() {
        return None;
    }
    rx.recv_timeout(timeout).ok()
}

fn cores() -> Option<u32> {
    std::thread::available_parallelism()
        .ok()
        .map(|n| u32::try_from(n.get()).unwrap_or(u32::MAX))
        .filter(|n| *n > 0)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn load1() -> Option<f64> {
    let mut avg = [0f64; 1];
    let n = unsafe { libc::getloadavg(avg.as_mut_ptr(), 1) };
    if n >= 1 {
        round3(avg[0])
    } else {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn load1() -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
fn free_memory_bytes() -> Option<u128> {
    unsafe extern "C" {
        fn mach_host_self() -> u32;
    }
    unsafe {
        let mut stats: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let rc = libc::host_statistics64(
            mach_host_self(),
            libc::HOST_VM_INFO64,
            &mut stats as *mut libc::vm_statistics64 as libc::host_info64_t,
            &mut count,
        );
        if rc != 0 {
            return None;
        }
        let page = libc::sysconf(libc::_SC_PAGESIZE);
        if page <= 0 {
            return None;
        }
        let free = u128::from(std::ptr::addr_of!(stats.free_count).read_unaligned());
        let inactive = u128::from(std::ptr::addr_of!(stats.inactive_count).read_unaligned());
        Some(free.saturating_add(inactive).saturating_mul(page as u128))
    }
}

#[cfg(target_os = "linux")]
fn free_memory_bytes() -> Option<u128> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = mem_available_kb(&text)?;
    Some((kb * 1024.0) as u128)
}

/// `MemAvailable` from a meminfo body, else `MemFree`. Kilobytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn mem_available_kb(text: &str) -> Option<f64> {
    labeled_kb(text, "MemAvailable:").or_else(|| labeled_kb(text, "MemFree:"))
}

fn labeled_kb(text: &str, label: &str) -> Option<f64> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some(label) {
            continue;
        }
        let kb = parts.next()?.parse::<f64>().ok()?;
        if kb.is_finite() && kb >= 0.0 {
            return Some(kb);
        }
    }
    None
}

#[cfg(windows)]
fn free_memory_bytes() -> Option<u128> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut info: MEMORYSTATUSEX = std::mem::zeroed();
        info.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut info) == 0 {
            return None;
        }
        Some(u128::from(info.ullAvailPhys))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn free_memory_bytes() -> Option<u128> {
    None
}

#[cfg(unix)]
fn disk_bytes() -> Option<u128> {
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c"/".as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let block = if stat.f_frsize > 0 {
        stat.f_frsize
    } else {
        stat.f_bsize
    };
    if block == 0 {
        return None;
    }
    Some(u128::from(stat.f_bavail).saturating_mul(u128::from(block)))
}

#[cfg(windows)]
fn disk_bytes() -> Option<u128> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    unsafe {
        let mut free = 0u64;
        // Null uses the current disk. There is no path to pass in.
        if GetDiskFreeSpaceExW(
            std::ptr::null(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        Some(u128::from(free))
    }
}

#[cfg(not(any(unix, windows)))]
fn disk_bytes() -> Option<u128> {
    None
}

fn free_disk_bytes() -> Option<u128> {
    within(DISK_TIMEOUT, disk_bytes).flatten()
}

fn gather() -> Result<Reading, ()> {
    let reading = Reading {
        load1: load1(),
        cores: cores(),
        free_memory_gb: free_memory_bytes().and_then(bytes_to_gb),
        free_disk_gb: free_disk_bytes().and_then(bytes_to_gb),
    };
    if reading.load1.is_none()
        && reading.cores.is_none()
        && reading.free_memory_gb.is_none()
        && reading.free_disk_gb.is_none()
    {
        Err(())
    } else {
        Ok(reading)
    }
}

fn cache() -> MutexGuard<'static, Option<Held>> {
    static CACHE: Mutex<Option<Held>> = Mutex::new(None);
    CACHE.lock().unwrap_or_else(|error| error.into_inner())
}

fn current() -> BuilderHealth {
    let mut held = cache();
    let now = now_ms();
    let reading = recall(&mut held, now, gather);
    let read_at = taken_at(&held, now);
    BuilderHealth {
        load1: reading.load1,
        cores: reading.cores,
        free_memory_gb: reading.free_memory_gb,
        free_disk_gb: reading.free_disk_gb,
        read_at,
    }
}

/// WP-161. No arguments: nothing here can be pointed at a file.
#[tauri::command(async)]
pub fn builder_health() -> BuilderHealth {
    current()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hot() -> Reading {
        Reading {
            load1: Some(9.0),
            cores: Some(4),
            free_memory_gb: Some(1.0),
            free_disk_gb: Some(2.0),
        }
    }

    #[test]
    fn reuses_a_sample_for_four_seconds_and_reads_again_after() {
        let mut held = None;
        let mut calls = 0;
        let first = recall(&mut held, 1_000, || {
            calls += 1;
            Ok(hot())
        });
        let second = recall(&mut held, 4_999, || {
            calls += 1;
            Ok(empty_reading())
        });
        assert_eq!(first, hot());
        assert_eq!(second, hot());
        assert_eq!(calls, 1);
        let third = recall(&mut held, 5_000, || {
            calls += 1;
            Ok(Reading {
                load1: Some(1.0),
                ..hot()
            })
        });
        assert_eq!(third.load1, Some(1.0));
        assert_eq!(calls, 2);
    }

    #[test]
    fn a_failed_read_keeps_a_recent_sample_and_does_not_replace_it() {
        let mut held = None;
        recall(&mut held, 0, || Ok(hot()));
        let mut calls = 0;
        let kept = recall(&mut held, 10_000, || {
            calls += 1;
            Err(())
        });
        assert_eq!(kept, hot());
        assert_eq!(calls, 1);
        // The failure is not served back. The next try waits out the cache, then reads again.
        let still = recall(&mut held, 13_999, || {
            calls += 1;
            Err(())
        });
        assert_eq!(still, hot());
        assert_eq!(calls, 1);
        let again = recall(&mut held, 14_000, || {
            calls += 1;
            Err(())
        });
        assert_eq!(again, hot());
        assert_eq!(calls, 2);
        assert_eq!(held.as_ref().unwrap().taken_at, 0);
    }

    #[test]
    fn a_failed_read_drops_a_sample_older_than_fifteen_seconds() {
        let mut held = None;
        recall(&mut held, 0, || Ok(hot()));
        let dropped = recall(&mut held, 15_001, || Err(()));
        assert_eq!(dropped, empty_reading());
        assert_eq!(held.as_ref().unwrap().taken_at, 15_001);
    }

    #[test]
    fn a_slow_read_comes_back_missing_instead_of_waiting() {
        let started = std::time::Instant::now();
        let value = within(Duration::from_millis(40), || {
            std::thread::sleep(Duration::from_millis(300));
            1
        });
        assert_eq!(value, None);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(within(Duration::from_millis(200), || 7), Some(7));
    }

    #[test]
    fn reads_available_memory_from_a_meminfo_body() {
        let text = "MemTotal: 16384000 kB\nMemFree: 1000 kB\nMemAvailable: 1048576 kB\n";
        assert_eq!(mem_available_kb(text), Some(1_048_576.0));
        assert_eq!(bytes_to_gb((1_048_576.0 * 1024.0) as u128), Some(1.0));
        assert_eq!(mem_available_kb("MemFree: 2048 kB\n"), Some(2048.0));
        assert_eq!(
            mem_available_kb("MemAvailable: nope kB\nMemFree: 10 kB\n"),
            Some(10.0)
        );
        assert_eq!(mem_available_kb(""), None);
        assert_eq!(mem_available_kb("MemAvailable: -1 kB\n"), None);
    }

    #[test]
    fn the_live_sample_has_no_path_and_a_fresh_clock() {
        let before = now_ms();
        let sample = current();
        let after = now_ms();
        assert!(sample.read_at >= before && sample.read_at <= after);
        let again = current();
        assert_eq!(again.read_at, sample.read_at);
        let text = serde_json::to_string(&sample).unwrap();
        assert!(!text.contains("path"));
        assert!(!text.contains("claude"));
        if let Some(cores) = sample.cores {
            assert!(cores >= 1);
        }
        for value in [sample.load1, sample.free_memory_gb, sample.free_disk_gb]
            .into_iter()
            .flatten()
        {
            assert!(value.is_finite() && value >= 0.0);
        }
    }
}
