//! The helper's XPC service. launchd advertises it; this process does not register a LaunchAgent.
//!
//! Every message is checked before the session hears it. The listener and the one accepted peer each get a code
//! requirement (the Hub's identifier, an Apple anchor, this helper's team) before the connection is resumed, and each
//! message is checked again. A peer that fails is refused, and that refusal does not ask for a permission or open the
//! microphone. Nothing here is called from a test: `serve` starts with the gate, which refuses while dictation is off,
//! before any listener is created.

use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
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
    // No resume unless the requirement is set. A missing symbol or a rejected string refuses, and the microphone
    // stays closed.
    if listener.is_null() || !set_peer_requirement(listener, &requirement) {
        if !listener.is_null() {
            unsafe { xpc_release(listener) };
        }
        protocol::emit(&Event::Refused { reason: "not_here" });
        return;
    }
    let (tx, rx) = mpsc::channel();
    let session_tx = tx.clone();
    let shared = Arc::new(Mutex::new(tx));
    let requirement: Arc<str> = Arc::from(requirement);
    let accepted = Arc::new(AtomicBool::new(false));
    let req_bits = peer_req as usize;
    let handler = RcBlock::new(move |event: Xpc| {
        on_listener(event, &requirement, req_bits, &shared, &accepted);
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

fn on_listener(
    event: Xpc,
    requirement: &str,
    peer_req_bits: usize,
    tx: &Arc<Mutex<Sender<Input>>>,
    accepted: &AtomicBool,
) {
    if is_type(event, ptr::addr_of!(_xpc_type_error)) {
        send_input(tx, Input::Closed);
        return;
    }
    if !is_type(event, ptr::addr_of!(_xpc_type_connection)) {
        return;
    }
    // One dictation per process. A later peer is cancelled and never resumed, so it is never checked in as the Hub.
    if accepted.swap(true, Ordering::SeqCst) {
        unsafe { xpc_connection_cancel(event) };
        return;
    }
    if !set_peer_requirement(event, requirement) {
        unsafe { xpc_connection_cancel(event) };
        send_input(tx, Input::Closed);
        return;
    }
    let peer_bits = event as usize;
    attach_sink(peer_bits);
    let tx = Arc::clone(tx);
    let handler = RcBlock::new(move |message: Xpc| {
        on_message(peer_req_bits, message, &tx);
    });
    let handler: &'static RcBlock<dyn Fn(Xpc)> = Box::leak(Box::new(handler));
    unsafe {
        xpc_connection_set_event_handler(event, handler);
        xpc_connection_resume(event);
    }
}

fn on_message(req_bits: usize, event: Xpc, tx: &Arc<Mutex<Sender<Input>>>) {
    if is_type(event, ptr::addr_of!(_xpc_type_error)) {
        send_input(tx, Input::Closed);
        return;
    }
    if !is_type(event, ptr::addr_of!(_xpc_type_dictionary)) {
        return;
    }
    // Fail closed: a missing check, a null requirement or a peer that does not meet it never becomes a command.
    let meets = message_meets(req_bits as Xpc, event);
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

/// Session events go to this peer, not to stdout.
fn attach_sink(peer_bits: usize) {
    protocol::set_line_sink(Arc::new(move |line: &str| {
        send_line(peer_bits as Xpc, line);
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
