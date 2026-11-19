// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/emulate (Apache-2.0), Copyright 2025 Chris Tate.
// Hivra WP-90: outside services are replaced by one local stand-in per stack.

//! Local stand-ins for outside services (WP-90). The 14 emulators themselves run as emulate's
//! pinned Node package; only the base-URL rules and the file store are translated here.

pub mod base_url;
pub mod emulate;
#[cfg(windows)]
mod process_win;
pub mod store;
