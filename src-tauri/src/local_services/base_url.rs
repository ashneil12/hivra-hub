// SPDX-License-Identifier: Apache-2.0
// Source: vercel-labs/emulate packages/emulate/src/base-url.ts (Apache-2.0).
// Copyright 2025 Chris Tate.
// Translated to Rust for Hivra WP-90, keeping the precedence and `{service}` replacement.

//! Which URL a stand-in advertises, in emulate's order.

pub struct BaseUrlOptions<'a> {
    pub service: &'a str,
    pub port: u16,
    /// The explicit base URL (a CLI flag or a programmatic option).
    pub base_url: Option<&'a str>,
    /// The per-service base URL from the seed config.
    pub seed_base_url: Option<&'a str>,
    /// `EMULATE_BASE_URL` from the environment.
    pub emulate_env: Option<&'a str>,
    /// `PORTLESS_URL` from the environment.
    pub portless_env: Option<&'a str>,
}

/// emulate's chain: the seed's own URL, then the explicit one, then `EMULATE_BASE_URL`, then
/// `PORTLESS_URL`, then `http://localhost:<port>`. An empty value is skipped, and every
/// `{service}` becomes the service's name.
pub fn resolve(options: BaseUrlOptions<'_>) -> String {
    for candidate in [
        options.seed_base_url,
        options.base_url,
        options.emulate_env,
        options.portless_env,
    ]
    .into_iter()
    .flatten()
    {
        if !candidate.is_empty() {
            return candidate.replace("{service}", options.service);
        }
    }
    format!("http://localhost:{}", options.port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options<'a>() -> BaseUrlOptions<'a> {
        BaseUrlOptions {
            service: "github",
            port: 22010,
            base_url: None,
            seed_base_url: None,
            emulate_env: None,
            portless_env: None,
        }
    }

    #[test]
    fn the_seed_url_wins_then_the_explicit_one_then_the_environment() {
        let mut opts = options();
        opts.seed_base_url = Some("http://seed.localhost:7000");
        opts.base_url = Some("http://explicit.localhost:7001");
        opts.emulate_env = Some("http://emulate.localhost:7002");
        opts.portless_env = Some("http://portless.localhost:7003");
        assert_eq!(resolve(opts), "http://seed.localhost:7000");

        let mut opts = options();
        opts.base_url = Some("http://explicit.localhost:7001");
        opts.emulate_env = Some("http://emulate.localhost:7002");
        opts.portless_env = Some("http://portless.localhost:7003");
        assert_eq!(resolve(opts), "http://explicit.localhost:7001");

        let mut opts = options();
        opts.emulate_env = Some("http://emulate.localhost:7002");
        opts.portless_env = Some("http://portless.localhost:7003");
        assert_eq!(resolve(opts), "http://emulate.localhost:7002");

        let mut opts = options();
        opts.portless_env = Some("http://portless.localhost:7003");
        assert_eq!(resolve(opts), "http://portless.localhost:7003");
    }

    #[test]
    fn service_is_replaced_in_every_source() {
        let mut opts = options();
        opts.service = "stripe";
        opts.seed_base_url = Some("http://{service}-shop.localhost:7400");
        assert_eq!(resolve(opts), "http://stripe-shop.localhost:7400");

        let mut opts = options();
        opts.service = "stripe";
        opts.emulate_env = Some("http://{service}.emulate:{port}");
        assert_eq!(resolve(opts), "http://stripe.emulate:{port}");
    }

    #[test]
    fn an_empty_value_is_skipped_and_the_last_fallback_carries_the_port() {
        let mut opts = options();
        opts.seed_base_url = Some("");
        opts.base_url = Some("");
        opts.emulate_env = Some("");
        opts.portless_env = Some("");
        assert_eq!(resolve(opts), "http://localhost:22010");
    }
}
