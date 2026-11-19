//! Cocoa calls that report failure through an `NSError **` out-parameter.
//!
//! The error Cocoa writes there is autoreleased: the autorelease pool owns it, so it must never be released by hand.
//! 0.16.17 did (the dictation helper's SMAppService call wrapped it in `Retained::from_raw` and dropped it). The error
//! was freed once there and again when the thread's pool drained at thread exit, and the app crashed about two seconds
//! after launch, on the real launch only, because a dev copy never registers the helper. The ship rolled it back.

use std::ptr;

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;

/// Runs `call` inside its own autorelease pool, passing it the `NSError **` slot. Returns what `call` returned and
/// whether Cocoa wrote an error. The error is left to the pool, which frees it when `call` is done; nothing of it
/// outlives this function, so a caller can't hold it past the pool either.
pub(crate) fn with_out_error<R>(call: impl FnOnce(&mut *mut AnyObject) -> R) -> (R, bool) {
    autoreleasepool(|_| {
        let mut error: *mut AnyObject = ptr::null_mut();
        let result = call(&mut error);
        (result, !error.is_null())
    })
}

#[cfg(test)]
mod tests {
    use super::with_out_error;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;

    /// The same shape as the SMAppService call, against a folder that does not exist, on threads that end right
    /// after, the way the registrar's thread does. Releasing the error by hand as well crashes this test process when
    /// a thread's pool drains, which is how 0.16.17 died at launch.
    #[test]
    fn an_error_cocoa_writes_is_left_to_its_pool() {
        for _ in 0..8 {
            let wrote_error = std::thread::spawn(|| {
                let class = AnyClass::get(c"NSFileManager").expect("Foundation has NSFileManager");
                let manager: Retained<AnyObject> = unsafe { msg_send![class, defaultManager] };
                let path = NSString::from_str("/nonexistent/hivra-cocoa-out-error-test");
                let (listing, wrote_error) =
                    with_out_error(|error| -> Option<Retained<AnyObject>> {
                        unsafe {
                            msg_send![&*manager, contentsOfDirectoryAtPath: &*path, error: error]
                        }
                    });
                assert!(listing.is_none());
                wrote_error
            })
            .join()
            .expect("the thread panicked");
            assert!(
                wrote_error,
                "Cocoa reported no error for a folder that does not exist"
            );
        }
    }
}
