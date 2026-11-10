// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack workspace-config (Apache-2.0).
// Translated to Rust. HumanLayer's TypeScript is not vendored.

//! A project's stack, declared in `.monocode/project.json`. No `stack` means the project is left alone.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

const MAX_SERVICES: usize = 8;
/// One worktree gets one block of ten ports (`stacks::BLOCK`).
const MAX_PORTS: usize = 10;
const MAX_VALUE: usize = 500;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StackDecl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<String>,
    pub services: Vec<ServiceDecl>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceDecl {
    pub name: String,
    /// Compose service name, when it differs from `name` (the container to start).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ports: Vec<PortDecl>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// WP-90: this service is an outside service, and the stack's stand-in answers for it
    /// (`"github"` and the other 13). The stand-in gets its own port from the block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emulate: Option<String>,
    /// The variable carrying its named base URL. Defaults to `<SERVICE>_BASE_URL`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortDecl {
    pub env: String,
    /// The first of these becomes the task card's local URL.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub url: bool,
}

pub fn validate(stack: &StackDecl) -> Result<(), String> {
    if stack.services.is_empty() {
        return Err("stack.services must name at least one service".into());
    }
    if stack.services.len() > MAX_SERVICES {
        return Err(format!(
            "stack.services can name at most {MAX_SERVICES} services"
        ));
    }
    if let Some(file) = &stack.compose_file {
        if !crate::project_file::valid_relative_path(file) {
            return Err(format!(
                "stack.composeFile {file:?} must be a plain relative path inside the checkout"
            ));
        }
    }
    let mut seen_services = HashSet::new();
    let mut seen_env = HashSet::new();
    let mut seen_emulated = HashSet::new();
    let mut port_names = Vec::new();
    let mut ports = 0usize;
    for service in &stack.services {
        if !valid_service(&service.name) {
            return Err(format!(
                "service name {:?} must be a short lowercase name",
                service.name
            ));
        }
        if !seen_services.insert(service.name.as_str()) {
            return Err(format!("service {:?} is named twice", service.name));
        }
        if let Some(compose) = &service.compose {
            if !valid_service(compose) {
                return Err(format!(
                    "service {:?} compose name {compose:?} must be a short lowercase name",
                    service.name
                ));
            }
        }
        if service.ports.is_empty()
            && service.env.is_empty()
            && service.compose.is_none()
            && service.emulate.is_none()
        {
            return Err(format!(
                "service {:?} needs a port, an env value, a compose name or an emulated service",
                service.name
            ));
        }
        if let Some(emulated) = &service.emulate {
            if !crate::local_services::emulate::is_service(emulated) {
                return Err(format!(
                    "service {:?} names {emulated:?}, which is not one of emulate's services",
                    service.name
                ));
            }
            if !seen_emulated.insert(emulated.as_str()) {
                return Err(format!("the {emulated} stand-in is named twice"));
            }
            // Each emulated service needs one port from this block for its stand-in.
            ports += 1;
            if ports > MAX_PORTS {
                return Err(format!("a stack can ask for at most {MAX_PORTS} ports"));
            }
            let env = service
                .url_env
                .clone()
                .unwrap_or_else(|| crate::local_services::emulate::env_name(emulated));
            if !valid_env(&env) {
                return Err(format!("urlEnv {env:?} must be an uppercase name"));
            }
            if !seen_env.insert(env.clone()) {
                return Err(format!("{env} is already used, so it can't be set again"));
            }
        } else if service.url_env.is_some() {
            return Err(format!(
                "service {:?} sets urlEnv without an emulated service",
                service.name
            ));
        }
        for port in &service.ports {
            ports += 1;
            if ports > MAX_PORTS {
                return Err(format!("a stack can declare at most {MAX_PORTS} ports"));
            }
            if !valid_env(&port.env) {
                return Err(format!("port env {:?} must be an uppercase name", port.env));
            }
            if !seen_env.insert(port.env.clone()) {
                return Err(format!("port env {:?} is used twice", port.env));
            }
            port_names.push(port.env.clone());
        }
    }
    for service in &stack.services {
        for (key, value) in &service.env {
            if !valid_env(key) {
                return Err(format!("env {key:?} must be an uppercase name"));
            }
            if !seen_env.insert(key.clone()) {
                return Err(format!("{key} is already used, so it can't be set again"));
            }
            check_value(value, &port_names)?;
        }
    }
    Ok(())
}

/// The emulated services a stack declares, in declaration order.
pub fn emulated(stack: &StackDecl) -> Vec<&ServiceDecl> {
    stack
        .services
        .iter()
        .filter(|service| service.emulate.is_some())
        .collect()
}

/// The variable a declared service's named base URL goes in.
pub fn base_url_env(service: &ServiceDecl) -> Option<String> {
    service.emulate.as_ref().map(|emulated| {
        service
            .url_env
            .clone()
            .unwrap_or_else(|| crate::local_services::emulate::env_name(emulated))
    })
}

fn valid_service(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && (1..=31).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub(crate) fn valid_env(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
        && (1..=41).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn check_value(value: &str, ports: &[String]) -> Result<(), String> {
    if value.len() > MAX_VALUE
        || value.contains('\0')
        || value.contains('\r')
        || value.contains('\n')
    {
        return Err(format!(
            "an env value must be one line of at most {MAX_VALUE} characters"
        ));
    }
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            return Err("an env value has an unclosed ${".into());
        };
        let name = &after[..end];
        if !ports.iter().any(|port| port == name) {
            return Err(format!(
                "an env value can only use ${{PORT}} names this stack declares, not {name}"
            ));
        }
        rest = &after[end + 1..];
    }
    if rest.contains('$') {
        return Err("an env value can only use ${PORT} names this stack declares".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{base_url_env, emulated};

    const DECLARED: &str = r#"{
      "version": 1,
      "stack": {
        "composeFile": "docker-compose.yml",
        "services": [
          {"name": "web", "ports": [{"env": "PORT", "url": true}, {"env": "VITE_PORT"}]},
          {"name": "db", "compose": "postgres", "ports": [{"env": "DATABASE_PORT"}],
           "env": {"DATABASE_URL": "postgres://127.0.0.1:${DATABASE_PORT}/app"}}
        ]
      }
    }"#;

    #[test]
    fn a_declared_stack_parses_and_a_missing_one_stays_absent() {
        let file = crate::project_file::parse(DECLARED).unwrap();
        let stack = file.stack.unwrap();
        assert_eq!(stack.compose_file.as_deref(), Some("docker-compose.yml"));
        assert_eq!(stack.services.len(), 2);
        assert!(stack.services[0].ports[0].url);
        assert!(!stack.services[0].ports[1].url);
        let bare = crate::project_file::parse(r#"{"version":1}"#).unwrap();
        assert!(bare.stack.is_none());
        let text = serde_json::to_string(&bare).unwrap();
        assert!(!text.contains("stack"));
    }

    #[test]
    fn an_emulated_service_gets_a_port_and_its_own_url_variable() {
        let file = crate::project_file::parse(
            r#"{"version":1,"stack":{"services":[
              {"name":"web","ports":[{"env":"PORT","url":true}]},
              {"name":"github","emulate":"github"},
              {"name":"billing","emulate":"stripe","urlEnv":"STRIPE_URL"}
            ]}}"#,
        )
        .unwrap();
        let stack = file.stack.unwrap();
        assert_eq!(emulated(&stack).len(), 2);
        assert_eq!(base_url_env(&stack.services[1]).unwrap(), "GITHUB_BASE_URL");
        assert_eq!(base_url_env(&stack.services[2]).unwrap(), "STRIPE_URL");
        // A service with only an emulated name is valid and counts as a port.
        crate::stack_decl::validate(&stack).unwrap();
    }

    #[test]
    fn an_emulated_service_that_is_not_real_or_asks_for_too_much_is_refused() {
        let cases = [
            (
                r#"{"version":1,"stack":{"services":[{"name":"github","emulate":"gitlab"}]}}"#,
                "not one of emulate",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"a","emulate":"github"},{"name":"b","emulate":"github"}]}}"#,
                "named twice",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"github","emulate":"github","urlEnv":"github_url"}]}}"#,
                "uppercase",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","urlEnv":"WEB_URL","ports":[{"env":"PORT"}]}]}}"#,
                "without an emulated service",
            ),
            (
                r#"{"version":1,"stack":{"services":[
                  {"name":"web","ports":[{"env":"P0"},{"env":"P1"},{"env":"P2"},{"env":"P3"},{"env":"P4"},{"env":"P5"},{"env":"P6"},{"env":"P7"},{"env":"P8"}]},
                  {"name":"github","emulate":"github"},{"name":"stripe","emulate":"stripe"}]}}"#,
                "at most 10",
            ),
        ];
        for (text, needle) in cases {
            let error = crate::project_file::parse(text).unwrap_err();
            assert!(error.contains(needle), "{text} -> {error}");
        }
    }

    #[test]
    fn refuses_a_stack_that_would_escape_or_clash() {
        let cases = [
            (
                r#"{"version":1,"stack":{"services":[]}}"#,
                "at least one service",
            ),
            (
                r#"{"version":1,"stack":{"composeFile":"../docker-compose.yml","services":[{"name":"web","ports":[{"env":"PORT"}]}]}}"#,
                "composeFile",
            ),
            (
                r#"{"version":1,"stack":{"composeFile":"a\\b.yml","services":[{"name":"web","ports":[{"env":"PORT"}]}]}}"#,
                "composeFile",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"PORT"}]},{"name":"api","ports":[{"env":"PORT"}]}]}}"#,
                "used twice",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"Web","ports":[{"env":"PORT"}]}]}}"#,
                "lowercase",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web"}]}}"#,
                "needs a port",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"port"}]}]}}"#,
                "uppercase",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"PORT"}],"env":{"PORT":"1"}}]}}"#,
                "already used",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"PORT"}],"env":{"DATABASE_URL":"postgres://127.0.0.1:${OTHER}/app"}}]}}"#,
                "not OTHER",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"PORT"}],"env":{"NOTE":"line\nbreak"}}]}}"#,
                "one line",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","image":"nope","ports":[{"env":"PORT"}]}]}}"#,
                "unknown field",
            ),
            (
                r#"{"version":1,"stack":{"services":[{"name":"web","ports":[{"env":"P0"},{"env":"P1"},{"env":"P2"},{"env":"P3"},{"env":"P4"},{"env":"P5"},{"env":"P6"},{"env":"P7"},{"env":"P8"},{"env":"P9"},{"env":"P10"}]}]}}"#,
                "at most 10",
            ),
        ];
        for (text, needle) in cases {
            let error = crate::project_file::parse(text).unwrap_err();
            assert!(error.contains(needle), "{text} -> {error}");
        }
    }
}
