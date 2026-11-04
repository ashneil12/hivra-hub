// WP-09: Windows and Linux seams for keep-awake, crash relaunch, secrets and the ship runner.
// macOS keeps the code it already has. These modules are what the other two platforms call,
// and the pure pieces (quoting, flags, unit text) are tested on every platform.

pub mod relaunch;
pub mod secrets;
pub mod ship;
pub mod wake;
