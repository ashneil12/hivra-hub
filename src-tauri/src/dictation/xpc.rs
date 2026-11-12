//! The Hub's side of the dictation service. Compiled out of the test build, so a test cannot open the Mach service
//! and cannot call SMAppService.
//!
//! The Hub does not spawn the helper. It connects to the Mach service the launch agent advertises, and it sets the
//! helper's code requirement before that connection is resumed. A missing symbol or a rejected requirement refuses
//! the connection.

use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use block2::{Block, RcBlock};
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2_foundation::NSString;

use super::{follow_switch, AgentControl, MACH_SERVICE, MAX_LINE_BYTES};

type Xpc = *mut c_void;

extern "C" {
    static _xpc_type_dictionary: u8;
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

#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

/// One line from the helper, or the connection closing.
pub enum Incoming {
    Text(String),
    Closed,
}

/// The open connection. Cancelling it is how a session stops the helper.
pub struct Link {
    connection: usize,
    cancelled: AtomicBool,
}

impl Link {
    pub fn send_line(&self, line: &str) -> bool {
        let Ok(text) = CString::new(line) else {
            return false;
        };
        let peer = self.connection as Xpc;
        unsafe {
            let dict = xpc_dictionary_create_empty();
            if dict.is_null() {
                return false;
            }
            xpc_dictionary_set_string(dict, c"line".as_ptr(), text.as_ptr());
            xpc_connection_send_message(peer, dict);
            xpc_release(dict);
        }
        true
    }

    /// Cancels the connection. Safe to call more than once. The connection itself is released when this value drops.
    pub fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe { xpc_connection_cancel(self.connection as Xpc) };
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        let peer = self.connection as Xpc;
        if !peer.is_null() && !self.cancelled.swap(true, Ordering::SeqCst) {
            unsafe { xpc_connection_cancel(peer) };
        }
        if !peer.is_null() {
            unsafe { xpc_release(peer) };
        }
    }
}

/// Connects to the helper's Mach service. The requirement is set before the connection is resumed. Err when that
/// cannot be done, and then no connection is resumed.
pub fn connect(requirement: &str) -> Result<(Link, Receiver<Incoming>), ()> {
    let Ok(name) = CString::new(MACH_SERVICE) else {
        return Err(());
    };
    let connection =
        unsafe { xpc_connection_create_mach_service(name.as_ptr(), ptr::null_mut(), 0) };
    if connection.is_null() || !set_peer_requirement(connection, requirement) {
        if !connection.is_null() {
            unsafe { xpc_release(connection) };
        }
        return Err(());
    }
    let (tx, rx) = mpsc::channel();
    let tx = Arc::new(Mutex::new(tx));
    let handler = RcBlock::new(move |event: Xpc| on_event(event, &tx));
    // The connection can call the block after this function returns. Leaking it keeps that call valid.
    let handler: &'static RcBlock<dyn Fn(Xpc)> = Box::leak(Box::new(handler));
    unsafe {
        xpc_connection_set_event_handler(connection, handler);
        xpc_connection_resume(connection);
    }
    Ok((
        Link {
            connection: connection as usize,
            cancelled: AtomicBool::new(false),
        },
        rx,
    ))
}

fn on_event(event: Xpc, tx: &Arc<Mutex<Sender<Incoming>>>) {
    let incoming = if is_type(event, ptr::addr_of!(_xpc_type_error)) {
        Incoming::Closed
    } else if is_type(event, ptr::addr_of!(_xpc_type_dictionary)) {
        match line_of(event) {
            Some(line) if line.len() <= MAX_LINE_BYTES => Incoming::Text(line),
            Some(_) => Incoming::Closed,
            None => return,
        }
    } else {
        return;
    };
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(incoming);
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

/// False when the symbol is missing or the requirement is rejected. The caller must not resume.
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

/// Follows the dictation switch with the real registrar. Not called from a test.
pub fn apply_switch(enabled: bool) {
    follow_switch(enabled, &mut SystemAgent);
}

struct SystemAgent;

impl AgentControl for SystemAgent {
    fn register_agent(&mut self, plist_name: &str) {
        let _ = app_service(plist_name, true);
    }

    fn unregister_agent(&mut self, plist_name: &str) {
        let _ = app_service(plist_name, false);
    }
}

/// Calls SMAppService. The result is ignored: unregistering a job that is not there reports an error, and that is
/// not a failure. Nothing is logged. The error belongs to the autorelease pool (`with_out_error`): releasing it by
/// hand crashed 0.16.17 at launch, when this thread ended.
fn app_service(plist_name: &str, register: bool) -> bool {
    let Some(class) = AnyClass::get(c"SMAppService") else {
        return false;
    };
    let name = NSString::from_str(plist_name);
    let service: Option<Retained<AnyObject>> =
        unsafe { msg_send![class, agentServiceWithPlistName: &*name] };
    let Some(service) = service else {
        return false;
    };
    let (ok, _) = crate::cocoa_out_error::with_out_error(|error| -> Bool {
        if register {
            unsafe { msg_send![&*service, registerAndReturnError: error] }
        } else {
            unsafe { msg_send![&*service, unregisterAndReturnError: error] }
        }
    });
    ok.as_bool()
}
