// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless packages/portless/src/cli-utils.ts and compose.ts (Apache-2.0).
// Copyright 2025 Vercel Inc.
// Translated to Rust for Hivra WP-90: the WHATWG blocked-port list, the four-address free-port
// probe and `allocatePorts`. The daily app's ports and Hivra's own ranges are added here.

//! Ports. WP-87 owns a stack's block; this module only says whether a port is allowed and
//! whether it is really free on every address a server might take.

use std::collections::{BTreeMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};

/// Browsers refuse these ports (WHATWG fetch "bad port" list); frameworks reject them too.
/// Kept in the same order as portless's list so a review can compare them side by side.
pub const BLOCKED_PORTS: &[u16] = &[
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
    102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
    465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
    993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
    6668, 6669, 6679, 6697, 10080,
];

/// The daily app's ports and Hivra's own: the app itself, the standard web ports, the dev-slot
/// grid. A stack never takes one of these even if it is free.
pub fn builtin_reserved(port: u16) -> bool {
    port == 80 || port == 443 || port == 1420 || port == 1421 || (1430..=1919).contains(&port)
}

pub fn is_blocked(port: u16) -> bool {
    BLOCKED_PORTS.binary_search(&port).is_ok()
}

/// A port no stack may take: blocked by browsers, or reserved by Hivra or by the caller
/// (control, harness, proxy and emulator ports already in use).
pub fn is_reserved(port: u16, extra: &HashSet<u16>) -> bool {
    is_blocked(port) || builtin_reserved(port) || extra.contains(&port)
}

/// Whether every port in a block is allowed. The registry still probes each one.
pub fn block_is_usable(start: u16, size: u16, extra: &HashSet<u16>) -> bool {
    (0..size).all(|step| {
        start
            .checked_add(step)
            .is_some_and(|port| !is_reserved(port, extra))
    })
}

/// Addresses a port must be free on. A bind on one address does not see a listener on another
/// (on macOS a wildcard bind succeeds while 127.0.0.1 holds the port).
pub const PROBE_ADDRESSES: [IpAddr; 4] = [
    IpAddr::V4(Ipv4Addr::LOCALHOST),
    IpAddr::V6(Ipv6Addr::LOCALHOST),
    IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    IpAddr::V6(Ipv6Addr::UNSPECIFIED),
];

/// Whether nothing is listening on `port` on any of the four addresses. An address family the
/// machine does not have cannot hold the port, so it counts as free.
pub fn probe_free(port: u16) -> bool {
    PROBE_ADDRESSES
        .iter()
        .all(|address| free_on(port, *address))
}

pub fn free_on(port: u16, address: IpAddr) -> bool {
    match TcpListener::bind((address, port)) {
        Ok(listener) => {
            drop(listener);
            true
        }
        Err(error) => {
            matches!(error.kind(), std::io::ErrorKind::AddrNotAvailable)
                || error.raw_os_error() == Some(eafnosupport())
        }
    }
}

#[cfg(unix)]
fn eafnosupport() -> i32 {
    libc::EAFNOSUPPORT
}

#[cfg(windows)]
fn eafnosupport() -> i32 {
    10047 // WSAEAFNOSUPPORT
}

#[cfg(not(any(unix, windows)))]
fn eafnosupport() -> i32 {
    0
}

/// The next free port at or above `from`, never a reserved one. `None` when the range is used up.
pub fn next_free_from(from: u16, extra: &HashSet<u16>, probe: impl Fn(u16) -> bool) -> Option<u16> {
    (from..=u16::MAX).find(|port| !is_reserved(*port, extra) && probe(*port))
}

/// portless's `allocatePorts`: keep a stored port while it is still ours or free, otherwise
/// scan from `start_at` for one that is neither taken in this batch, reserved, nor in use.
///
/// WP-87's block owns a stack's ports; this is the translated allocator, exercised by its tests
/// and kept for a caller that has keys to place rather than a block to fill.
#[allow(dead_code, clippy::too_many_arguments)]
pub fn allocate_ports(
    keys: &[String],
    stored: &BTreeMap<String, u16>,
    min: u16,
    max: u16,
    reserved: &HashSet<u16>,
    ours: &HashSet<u16>,
    start_at: usize,
    is_free: impl Fn(u16) -> bool,
) -> Result<BTreeMap<String, u16>, String> {
    if min > max {
        return Err("The port range is backwards, so nothing was started.".into());
    }
    let size = usize::from(max - min) + 1;
    let mut ports = BTreeMap::new();
    let mut taken = HashSet::new();
    for key in keys {
        if let Some(previous) = stored.get(key).copied() {
            if !taken.contains(&previous)
                && !reserved.contains(&previous)
                && (ours.contains(&previous) || is_free(previous))
            {
                ports.insert(key.clone(), previous);
                taken.insert(previous);
                continue;
            }
        }
        let mut found = None;
        for step in 0..size {
            let candidate = min + ((start_at + step) % size) as u16;
            if taken.contains(&candidate) || reserved.contains(&candidate) {
                continue;
            }
            if is_free(candidate) {
                found = Some(candidate);
                break;
            }
        }
        let Some(port) = found else {
            return Err(format!("No free port is left in {min}-{max}."));
        };
        ports.insert(key.clone(), port);
        taken.insert(port);
    }
    Ok(ports)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserved() -> HashSet<u16> {
        HashSet::new()
    }

    #[test]
    fn the_blocked_list_is_sorted_and_contains_the_browsers_bad_ports() {
        assert!(BLOCKED_PORTS.windows(2).all(|pair| pair[0] < pair[1]));
        for port in [0, 1, 22, 6000, 10080] {
            assert!(is_blocked(port), "{port}");
        }
        for port in [80, 443, 3000, 7400, 22000] {
            assert!(!is_blocked(port), "{port}");
        }
        // 80 and 443 are reserved by the app, not by the browser list.
        assert!(is_reserved(80, &reserved()));
        assert!(is_reserved(443, &reserved()));
    }

    #[test]
    fn a_block_never_includes_a_reserved_or_blocked_port() {
        for (start, size) in [(1420, 12), (1430, 10), (80, 10)] {
            assert!(!block_is_usable(start, size, &reserved()), "{start}");
        }
        assert!(block_is_usable(22000, 10, &reserved()));
        assert!(block_is_usable(42000, 10, &reserved()));
        let mut extra = HashSet::new();
        extra.insert(22003);
        assert!(!block_is_usable(22000, 10, &extra));
    }

    #[test]
    fn allocation_skips_reserved_and_taken_ports_and_keeps_a_stored_one() {
        let keys = vec!["web".to_string(), "api".to_string(), "db".to_string()];
        let mut stored = BTreeMap::new();
        stored.insert("web".to_string(), 22005);
        let ports = allocate_ports(
            &keys,
            &stored,
            22000,
            22009,
            &reserved(),
            &HashSet::new(),
            0,
            |port| port != 22000,
        )
        .unwrap();
        assert_eq!(ports["web"], 22005);
        assert_eq!(ports["api"], 22001);
        assert_eq!(ports["db"], 22002);
    }

    #[test]
    fn a_stored_port_other_projects_reserved_is_not_reused() {
        let keys = vec!["web".to_string()];
        let mut stored = BTreeMap::new();
        stored.insert("web".to_string(), 22005);
        let mut reserved = HashSet::new();
        reserved.insert(22005);
        let ports = allocate_ports(
            &keys,
            &stored,
            22000,
            22009,
            &reserved,
            &HashSet::new(),
            0,
            |_| true,
        )
        .unwrap();
        assert_eq!(ports["web"], 22000);
    }

    #[test]
    fn the_probe_sees_a_port_taken_on_each_of_the_four_addresses() {
        for address in PROBE_ADDRESSES {
            let Ok(listener) = TcpListener::bind((address, 0)) else {
                // This machine has no such address family; the probe treats it as free.
                assert!(free_on(0, address));
                continue;
            };
            let port = listener.local_addr().unwrap().port();
            assert!(!free_on(port, address), "{address} on {port}");
            assert!(!probe_free(port), "probe must see {address} on {port}");
        }
    }

    #[test]
    fn the_next_free_port_skips_reserved_ones() {
        let mut extra = HashSet::new();
        extra.insert(7400);
        extra.insert(7401);
        assert_eq!(next_free_from(7400, &extra, |_| true), Some(7402));
        assert_eq!(next_free_from(1420, &reserved(), |_| true), Some(1422));
    }
}
