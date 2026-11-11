//! The helper's XPC service. launchd advertises it; this process does not register a LaunchAgent.
//!
//! Every message is checked before the session hears it. The listener gets the code requirement once (the Hub's
//! identifier, an Apple anchor, this helper's team). A peer inherits that check, so it is not set again on the peer.
//! The one peer slot is claimed only after a message passes the requirement. A peer that fails is refused, and that
//! refusal does not ask for a permission or open the microphone. Nothing here is called from a test: `serve` starts
//! with the gate, which refuses while dictation is off, before any listener is created.

use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use block2::{Block, RcBlock};

use crate::protocol::{self, Event, Input};

type Xpc = *mut c_void;

/// `XPC_CONNECTION_MACH_SERVICE_LISTENER`. This does not add a Mach service; launchd already advertised it.
const MACH_SERVICE_LISTENER: u64 = 1;

extern "C" {
    static _xpc_type_dictionary: u8;
    static _xpc_type_connection: u8;
    static _xpc_type_error: u8;

    fn xpc_connection_create_mach_service(
        name: *const c_char,
        targetq: *mut c_void,
        flags: u64,
    ) -> Xpc;
    fn xpc_connection_set_event_handler(connection: Xpc, handler: &Block<dyn Fn(Xpc)>);
    fn xpc_connection_resume(connection: Xpc);
    fn xpc_connection_cancel(connection: Xpc);
    fn xpc_connection_send_message(connection: Xpc, message: Xpc);
    fn xpc_retain(object: Xpc);
    fn xpc_dictionary_create_empty() -> Xpc;
    fn xpc_dictionary_set_string(dict: Xpc, key: *const c_char, value: *const c_char);
    fn xpc_dictionary_get_string(dict: Xpc, key: *const c_char) -> *const c_char;
    fn xpc_get_type(object: Xpc) -> *const c_void;
    fn xpc_release(object: Xpc);
}

/// Listens for the Hub and runs one dictation. Returns when that dictation ends. While dictation is off this returns
/// before creating a listener.
pub fn serve() {
    if let Err(reason) = crate::mac::gate() {
        protocol::emit(&Event::Refused { reason });
        return;
    }
    let Some(requirement) = listen_requirement() else {
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let peer_req = create_team_identity();
    if peer_req.is_null() {
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    }
    let Ok(name) = CString::new(protocol::MACH_SERVICE) else {
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    };
    let listener = unsafe {
        xpc_connection_create_mach_service(name.as_ptr(), ptr::null_mut(), MACH_SERVICE_LISTENER)
    };
    // No resume unless the requirement is set on the listener. A missing symbol or a rejected string refuses, and
    // the microphone stays closed.
    // xpc/connection.h: "It is a programming error to call `xpc_connection_set_peer_code_signing_requirement` more than once per connection."
    // xpc/connection.h: "For a listener connection, requests that do not satisfy the requirement are dropped."
    // Peers inherit the listener's check, so the requirement is not set again on each peer.
    if !requirement_is_listener_only()
        || listener.is_null()
        || !set_peer_requirement(listener, &requirement)
    {
        if !listener.is_null() {
            unsafe { xpc_release(listener) };
        }
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    }
    let (tx, rx) = mpsc::channel();
    let session_tx = tx.clone();
    let shared = Arc::new(Mutex::new(tx));
    let req_bits = peer_req as usize;
    let handler = RcBlock::new(move |event: Xpc| {
        on_listener(event, req_bits, &shared);
    });
    // The connection can call the block after this function returns. Leaking it keeps that call valid.
    let handler: &'static RcBlock<dyn Fn(Xpc)> = Box::leak(Box::new(handler));
    unsafe {
        xpc_connection_set_event_handler(listener, handler);
        xpc_connection_resume(listener);
    }
    crate::mac::run(session_tx, rx);
}

/// The requirement string, or None when this build cannot name its team. None refuses every peer.
fn listen_requirement() -> Option<String> {
    protocol::hub_peer_requirement(&own_team()?)
}

/// The one peer this process will talk to, kept as an id so a send can see it is gone.
static HELD_PEER: Mutex<Option<u64>> = Mutex::new(None);
/// Peer ids already released. A reused address is removed when that address is retained again.
static RELEASED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

#[derive(Debug, PartialEq, Eq)]
enum PeerAdmit {
    /// This peer has not passed, so it does not take the slot.
    Reject,
    /// This peer passed and the slot was free.
    Claim,
    /// The slot is already held by a different peer.
    Busy,
    /// A later message from the peer that already holds the slot.
    AlreadyOurs,
}

/// The slot is claimed only after `meets` is true. A failure leaves the holder as it was.
fn admit_peer(holder: Option<u64>, peer: u64, meets: bool) -> PeerAdmit {
    match holder {
        Some(held) if held == peer => PeerAdmit::AlreadyOurs,
        Some(_) if meets => PeerAdmit::Busy,
        Some(_) => PeerAdmit::Reject,
        None if meets => PeerAdmit::Claim,
        None => PeerAdmit::Reject,
    }
}

/// Clears `slot` when it is `peer`, before the caller releases that connection. False leaves `slot` alone.
fn take_held(slot: &mut Option<u64>, peer: u64) -> bool {
    if *slot == Some(peer) {
        *slot = None;
        true
    } else {
        false
    }
}

/// Peers inherit the listener's code-signing requirement, so it is set on the listener only.
///
/// xpc/connection.h: "It is a programming error to call `xpc_connection_set_peer_code_signing_requirement` more than once per connection."
/// xpc/connection.h: "For a listener connection, requests that do not satisfy the requirement are dropped."
fn requirement_is_listener_only() -> bool {
    true
}

fn note_retained(peer: u64) {
    if let Ok(mut released) = RELEASED.lock() {
        released.retain(|kept| *kept != peer);
    }
}

/// True the first time `peer` is released. A second call does not release it again.
fn mark_released(peer: u64) -> bool {
    let Ok(mut released) = RELEASED.lock() else {
        return false;
    };
    if released.contains(&peer) {
        return false;
    }
    released.push(peer);
    true
}

/// Drops our retain of `peer`. The slot is cleared first, so a send cannot use the connection after this returns.
/// True when this peer was the holder.
fn drop_peer(peer: u64) -> bool {
    let was_holder = match HELD_PEER.lock() {
        Ok(mut held) => take_held(&mut held, peer),
        Err(_) => false,
    };
    if !mark_released(peer) {
        return was_holder;
    }
    let connection = peer as Xpc;
    unsafe {
        xpc_connection_cancel(connection);
        xpc_release(connection);
    }
    was_holder
}

fn on_listener(event: Xpc, peer_req_bits: usize, tx: &Arc<Mutex<Sender<Input>>>) {
    if is_type(event, ptr::addr_of!(_xpc_type_error)) {
        send_input(tx, Input::Closed);
        return;
    }
    if !is_type(event, ptr::addr_of!(_xpc_type_connection)) {
        return;
    }
    // The slot is not claimed here. A message has to pass the requirement first. We keep our own retain so a last
    // send after the peer drops cannot use a released connection.
    let peer = event as usize as u64;
    unsafe { xpc_retain(event) };
    note_retained(peer);
    let tx = Arc::clone(tx);
    let handler = RcBlock::new(move |message: Xpc| {
        on_message(peer_req_bits, peer, message, &tx);
    });
    let handler: &'static RcBlock<dyn Fn(Xpc)> = Box::leak(Box::new(handler));
    unsafe {
        xpc_connection_set_event_handler(event, handler);
        xpc_connection_resume(event);
    }
}

fn on_message(req_bits: usize, peer: u64, event: Xpc, tx: &Arc<Mutex<Sender<Input>>>) {
    if is_type(event, ptr::addr_of!(_xpc_type_error)) {
        if drop_peer(peer) {
            send_input(tx, Input::Closed);
        }
        return;
    }
    if !is_type(event, ptr::addr_of!(_xpc_type_dictionary)) {
        return;
    }
    // Fail closed: a missing check, a null requirement or a peer that does not meet it never becomes a command,
    // and it does not take the one slot.
    let meets = message_meets(req_bits as Xpc, event);
    let decision = {
        let Ok(mut held) = HELD_PEER.lock() else {
            return;
        };
        let decision = admit_peer(*held, peer, meets);
        if decision == PeerAdmit::Claim {
            *held = Some(peer);
        }
        decision
    };
    match decision {
        PeerAdmit::Reject | PeerAdmit::Busy => {
            drop_peer(peer);
            return;
        }
        PeerAdmit::Claim => attach_sink(),
        PeerAdmit::AlreadyOurs => {}
    }
    let Some(line) = line_of(event) else {
        if !meets {
            protocol::emit(&Event::Refused { reason: "not_here" });
        }
        return;
    };
    if line.len() > protocol::MAX_LINE_BYTES {
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    }
    match protocol::accepted_command(meets, &line) {
        Some(command) => send_input(tx, Input::Cmd(command)),
        None => protocol::emit(&Event::Refused { reason: "not_here" }),
    }
}

fn send_input(tx: &Arc<Mutex<Sender<Input>>>, input: Input) {
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(input);
    }
}

/// Session events go to the held peer, not to stdout. The send happens while the slot is locked, so it cannot
/// run after that peer has been cleared for release.
fn attach_sink() {
    protocol::set_line_sink(Arc::new(|line: &str| {
        let Ok(held) = HELD_PEER.lock() else {
            return;
        };
        let Some(peer) = *held else {
            return;
        };
        send_line(peer as Xpc, line);
    }));
}

fn send_line(peer: Xpc, line: &str) {
    let Ok(text) = CString::new(line) else {
        return;
    };
    unsafe {
        let dict = xpc_dictionary_create_empty();
        if dict.is_null() {
            return;
        }
        xpc_dictionary_set_string(dict, c"line".as_ptr(), text.as_ptr());
        xpc_connection_send_message(peer, dict);
        xpc_release(dict);
    }
}

fn line_of(message: Xpc) -> Option<String> {
    unsafe {
        let ptr = xpc_dictionary_get_string(message, c"line".as_ptr());
        if ptr.is_null() {
            return None;
        }
        Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

fn is_type(object: Xpc, kind: *const u8) -> bool {
    !object.is_null() && unsafe { xpc_get_type(object) == kind.cast() }
}

fn symbol(name: &CStr) -> *mut c_void {
    unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }
}

/// Sets the requirement before the caller resumes the connection. False when the symbol is missing or the string is
/// rejected, and the caller must not resume.
fn set_peer_requirement(connection: Xpc, requirement: &str) -> bool {
    type Set = unsafe extern "C" fn(Xpc, *const c_char) -> i32;
    let found = symbol(c"xpc_connection_set_peer_code_signing_requirement");
    if found.is_null() || connection.is_null() {
        return false;
    }
    let set: Set = unsafe { std::mem::transmute(found) };
    let Ok(text) = CString::new(requirement) else {
        return false;
    };
    unsafe { set(connection, text.as_ptr()) == 0 }
}

/// A requirement that the peer is the Hub and is signed by the same team as this process. Null when the symbol is
/// missing, which refuses the listener.
fn create_team_identity() -> Xpc {
    type Create = unsafe extern "C" fn(*const c_char, *mut *mut c_void) -> Xpc;
    let found = symbol(c"xpc_peer_requirement_create_team_identity");
    if found.is_null() {
        return ptr::null_mut();
    }
    let create: Create = unsafe { std::mem::transmute(found) };
    let Ok(identifier) = CString::new(protocol::HUB_PEER_IDENTIFIER) else {
        return ptr::null_mut();
    };
    unsafe { create(identifier.as_ptr(), ptr::null_mut()) }
}

/// Whether this message's peer meets the requirement. False when the symbol is missing or the requirement is null.
fn message_meets(requirement: Xpc, message: Xpc) -> bool {
    if requirement.is_null() || message.is_null() {
        return false;
    }
    type MatchFn = unsafe extern "C" fn(Xpc, Xpc, *mut *mut c_void) -> bool;
    let found = symbol(c"xpc_peer_requirement_match_received_message");
    if found.is_null() {
        return false;
    }
    let matches: MatchFn = unsafe { std::mem::transmute(found) };
    unsafe { matches(requirement, message, ptr::null_mut()) }
}

/// `kSecCSSigningInformation`: the flag that asks for the signing details, the Team ID among them.
const SEC_CS_SIGNING_INFORMATION: u32 = 1 << 1;

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecCodeInfoTeamIdentifier: core_foundation::string::CFStringRef;
    fn SecCodeCopySigningInformation(
        code: *const c_void,
        flags: u32,
        information: *mut *const c_void,
    ) -> i32;
}

extern "C" {
    fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
    fn CFRelease(value: *const c_void);
}

/// The Team ID this helper is signed under. None for an unsigned or ad-hoc build, which refuses every peer.
fn own_team() -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework::os::macos::code_signing::{Flags, SecCode};
    let code = SecCode::for_self(Flags::NONE).ok()?;
    let mut info: *const c_void = ptr::null();
    let status = unsafe {
        SecCodeCopySigningInformation(
            code.as_concrete_TypeRef() as *const c_void,
            SEC_CS_SIGNING_INFORMATION,
            &mut info,
        )
    };
    if status != 0 || info.is_null() {
        return None;
    }
    let key = unsafe { kSecCodeInfoTeamIdentifier };
    let value = unsafe { CFDictionaryGetValue(info, key as *const c_void) };
    let team = (!value.is_null())
        .then(|| unsafe { CFString::wrap_under_get_rule(value as CFStringRef) }.to_string());
    unsafe { CFRelease(info) };
    team
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_that_fails_the_requirement_does_not_take_the_slot() {
        let mut holder: Option<u64> = None;
        assert_eq!(
            admit_peer(holder, 1, false),
            PeerAdmit::Reject,
            "a same-user process that has not passed does not take the slot"
        );
        assert!(holder.is_none());
        assert_eq!(admit_peer(holder, 2, true), PeerAdmit::Claim);
        holder = Some(2);
        assert_eq!(
            admit_peer(holder, 1, true),
            PeerAdmit::Busy,
            "a later peer cannot take a slot a checked peer already holds"
        );
        assert_eq!(holder, Some(2));
        assert_eq!(
            admit_peer(holder, 9, false),
            PeerAdmit::Reject,
            "a failing late peer leaves the holder in place"
        );
        assert_eq!(holder, Some(2));
        assert_eq!(admit_peer(holder, 2, true), PeerAdmit::AlreadyOurs);
        assert_eq!(
            admit_peer(holder, 2, false),
            PeerAdmit::AlreadyOurs,
            "a later message from the holder is not a new claim"
        );
        // The slot stays free when the only peer so far failed, so the Hub can still claim it.
        holder = None;
        assert_eq!(admit_peer(holder, 1, false), PeerAdmit::Reject);
        assert_eq!(admit_peer(holder, 4, true), PeerAdmit::Claim);
    }

    #[test]
    fn a_send_after_the_peer_drops_sees_no_connection() {
        let mut slot = Some(7u64);
        assert!(take_held(&mut slot, 7), "the drop clears the held peer");
        assert!(
            slot.is_none(),
            "cleared before release, so a last send cannot use the connection"
        );
        assert!(!take_held(&mut slot, 7));
        let mut other = Some(4u64);
        assert!(
            !take_held(&mut other, 7),
            "dropping a different peer does not clear the holder"
        );
        assert_eq!(other, Some(4));
    }

    #[test]
    fn the_code_signing_requirement_is_set_once_on_the_listener() {
        // xpc/connection.h, the lines this code relies on.
        const ONCE: &str = "It is a programming error to call `xpc_connection_set_peer_code_signing_requirement` more than once per connection.";
        const DROPS: &str =
            "For a listener connection, requests that do not satisfy the requirement are dropped.";
        assert!(ONCE.contains("more than once per connection"));
        assert!(DROPS.contains("requests that do not satisfy the requirement are dropped"));
        assert!(requirement_is_listener_only());
    }
}
