//! Connectors: the apps a Mono's Claude Code sessions can use (GitHub, Gmail, Slack, Notion, …), local-first.
//!
//! - `catalog`: every connector and how it is launched (shared with the webview as JSON).
//! - `settings`: which are on, for which projects and Monos, and the Composio switch (`<data>/connectors.json`).
//! - `secrets`: logins, in the Keychain only.
//! - `launch`: `monocode connector-run`, what a session's MCP config points at; checks and serves at launch.
//! - `signing`: the app signs each session's connector arguments; the launcher refuses anything it didn't sign.
//! - `remote` + `bridge`: hosted MCP servers spoken to over stdio with the login held in memory.
//! - `oauth`: browser sign-in (MCP authorization with dynamic registration, or Google with Ash's own client).
//! - `renew`: renewing an OAuth login under a lock shared by every process that holds it.
//! - `builtin`: small servers for plain HTTP APIs (Telegram).
//! - `check`: the Test button.
//! - `commands`: the Connectors page's commands.
//!
//! A login is never written to a config file, a log or a command line (`commands::tests::end_to_end_…`).

mod bridge;
mod builtin;
pub mod catalog;
mod check;
pub mod commands;
pub mod launch;
// WP-61 reuses its PKCE, loopback callback and token exchange for Hivra Cloud.
pub(crate) mod oauth;
mod remote;
mod renew;
pub mod secrets;
pub mod settings;
pub mod signing;

pub use launch::run_main;
