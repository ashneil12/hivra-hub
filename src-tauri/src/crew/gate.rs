//! WP-141: the one gate a worker or session launch passes before its process starts. Route logic picks the CLI;
//! this decides. It refuses a CLI on Never use, a CLI other than the locked default while Always use my default is
//! on, and any launch whose policy can't be read. Nothing here starts or stops a process.

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use super::policy::cli_id_of;
use super::resolve::cli_label;
use super::store;

/// What a launch is about to run on, and the folder and Mono whose policy applies to it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    /// The CLI the process would start.
    pub cli: String,
    #[serde(default)]
    pub mono: Option<String>,
    /// The project's folder, which is what its policy is saved under.
    #[serde(default)]
    pub project: Option<String>,
    /// The CLI the lock pins for this launch: the crew route's own pick. None when no default is known.
    #[serde(default)]
    pub locked_default: Option<String>,
}

fn label_of(cli: &str) -> String {
    cli_id_of(cli)
        .map(cli_label)
        .map(str::to_string)
        .unwrap_or_else(|| cli.to_string())
}

fn lock_on(policy: &Value) -> bool {
    policy.get("lockDefault").and_then(Value::as_bool) == Some(true)
}

fn never_listed(policy: &Value) -> Vec<String> {
    policy
        .get("neverUse")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Ok when the launch may start. The reason is one plain line, shown to the person and the Lead.
pub fn check_launch(conn: &Connection, input: &LaunchCheck) -> Result<(), String> {
    let policy = store::policy_for(conn, input.mono.as_deref(), input.project.as_deref()).map_err(
        |error| format!("The crew policy could not be read, so nothing was started ({error})."),
    )?;
    let cli = input.cli.trim();
    let name = label_of(cli);
    if never_listed(&policy).iter().any(|id| id == cli) {
        return Err(format!("{name} is on Never use, so it was not started."));
    }
    if !lock_on(&policy) {
        return Ok(());
    }
    let locked = input
        .locked_default
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match locked {
        None => Err(format!(
            "Always use my default is on and no default CLI can take this work, so {name} was not started."
        )),
        Some(default) if default != cli => Err(format!(
            "Always use my default is on, and the default is {}, so {name} was not started.",
            label_of(default)
        )),
        Some(_) => Ok(()),
    }
}
