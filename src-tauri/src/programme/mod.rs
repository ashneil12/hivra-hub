//! WP-159: a programme of packages the first mate keeps.
//!
//! The idea of a row that waits, is claimed, then settles comes from firstmate's durable wake
//! queue. The table, the statuses and the park rule are Hivra's. This is not the per-job worker queue.

pub(crate) mod commands;
pub(crate) mod mcp;
mod store;

pub(crate) use store::ensure_tables;

#[cfg(test)]
mod store_tests;
