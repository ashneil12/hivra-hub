// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/portless (Apache-2.0), Copyright 2025 Vercel Inc.
// Hivra WP-90: one name per worktree, and a local proxy that routes by that name.

//! Named local addresses (WP-90): labels, the route registry, port allocation and the
//! plain-HTTP proxy. No TLS, no hosts file, no root: `.localhost` resolves to loopback by
//! itself and every URL this module makes carries the proxy's port.

pub mod labels;
pub mod ports;
pub mod routes;
pub mod server;
