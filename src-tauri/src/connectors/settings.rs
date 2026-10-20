//! Which connectors are on, where each one may be used, and the Composio switch: `<data>/connectors.json`.
//!
//! No secret is ever in this file (logins are in the Keychain, `secrets.rs`). The app writes it; the launcher reads it
//! again at every start, so turning a connector off for a project takes effect for the next session that starts.

use super::catalog::{Entry, Method};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Allowed everywhere: every project and Monos that aren't in one.
pub const EVERYWHERE: &str = "*";
/// Allowed for Monos that aren't in any project (the leadership team today).
pub const OUTSIDE: &str = "~";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Off by default (Ash 14 Oct). With it on, the Composio server is offered for the long tail; main apps still
    /// connect directly.
    #[serde(default)]
    pub composio: bool,
    /// The shared Google OAuth client is in the Keychain (its ID and secret are never here).
    #[serde(default)]
    pub google_client: bool,
    #[serde(default)]
    pub connectors: BTreeMap<String, ConnectorState>,
    /// Per Mono, by Mono id. A Mono with no entry gets every connector its projects allow.
    #[serde(default)]
    pub monos: BTreeMap<String, MonoChoice>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorState {
    /// A login is in the Keychain (or, for a no-login connector, it is turned on). The launcher checks the Keychain too.
    #[serde(default)]
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<Method>,
    /// Project keys (the project folder, `projectKey()`), [`EVERYWHERE`] or [`OUTSIDE`]. Empty: nobody yet.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Who the login is, when a test said ("ashneil12"). A name, never a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ok: bool,
    pub message: String,
    /// Unix seconds.
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum MonoChoice {
    /// Everything its projects allow, except these.
    All {
        #[serde(default)]
        except: Vec<String>,
    },
    /// Only these (and only where its projects allow them).
    Only {
        #[serde(default)]
        ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    NotSignedIn,
    NeedsComposio,
    /// A project the Mono works in doesn't allow it.
    ProjectOff(String),
    /// The Mono isn't in a project, and the connector isn't allowed outside projects.
    OutsideOff,
    MonoOff,
}

impl Denied {
    pub fn message(&self, name: &str) -> String {
        match self {
            Denied::NotSignedIn => format!("{name} isn't signed in. Sign in under Settings > Connectors."),
            Denied::NeedsComposio => "Composio is off. Turn it on under Settings > Connectors.".into(),
            Denied::ProjectOff(project) => {
                format!("{name} is off for the project {project}. Allow it under Settings > Connectors.")
            }
            Denied::OutsideOff => format!(
                "{name} isn't allowed for Monos outside a project. Allow it under Settings > Connectors."
            ),
            Denied::MonoOff => format!("{name} is off for this Mono."),
        }
    }
}

/// May this Mono, working in these projects, use this connector? Every project must allow it (least privilege: a
/// Mono in two projects only gets what both allow); a Mono in no project needs it allowed outside projects.
pub fn allowed(
    settings: &Settings,
    entry: &Entry,
    mono: &str,
    projects: &[String],
) -> Result<(), Denied> {
    let Some(state) = settings
        .connectors
        .get(&entry.id)
        .filter(|state| state.signed_in)
    else {
        return Err(Denied::NotSignedIn);
    };
    if entry.composio && !settings.composio {
        return Err(Denied::NeedsComposio);
    }
    let everywhere = state.allow.iter().any(|scope| scope == EVERYWHERE);
    if projects.is_empty() {
        if !everywhere && !state.allow.iter().any(|scope| scope == OUTSIDE) {
            return Err(Denied::OutsideOff);
        }
    } else if !everywhere {
        if let Some(off) = projects
            .iter()
            .find(|project| !state.allow.contains(project))
        {
            return Err(Denied::ProjectOff(off.clone()));
        }
    }
    match settings.monos.get(mono) {
        None => Ok(()),
        Some(MonoChoice::All { except }) if !except.contains(&entry.id) => Ok(()),
        Some(MonoChoice::Only { ids }) if ids.contains(&entry.id) => Ok(()),
        Some(_) => Err(Denied::MonoOff),
    }
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join("connectors.json")
}

/// A missing or unreadable file is "nothing connected yet": every connector stays off.
pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Written whole to a temporary file, then renamed over: the launcher never reads half a file. Owner-only.
pub fn save(dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|_| "Couldn't make the app's data folder.".to_string())?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|_| "Couldn't save the connector settings.".to_string())?;
    let tmp = dir.join(format!("connectors.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, raw).map_err(|_| "Couldn't save the connector settings.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path(dir)).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        "Couldn't save the connector settings.".to_string()
    })
}

/// Scopes come from the webview: project folders, `*` or `~`, nothing odd.
pub fn valid_scope(scope: &str) -> bool {
    !scope.is_empty() && scope.len() <= 4096 && !scope.chars().any(char::is_control)
}

/// Mono ids come from the roster (`mono-…`, or a hub id like `hivra-lead`).
pub fn valid_mono_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

#[cfg(test)]
mod tests {
    use super::super::catalog;
    use super::*;

    fn on(allow: &[&str]) -> ConnectorState {
        ConnectorState {
            signed_in: true,
            method: Some(Method::Token),
            allow: allow.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn settings(id: &str, state: ConnectorState) -> Settings {
        Settings {
            connectors: BTreeMap::from([(id.to_string(), state)]),
            ..Default::default()
        }
    }

    const HIVRA: &str = "/Users/ash/Projects/hivra";
    const NIBBII: &str = "/Users/ash/Projects/nibbii";

    #[test]
    fn a_mono_only_gets_what_every_one_of_its_projects_allows() {
        let github = catalog::entry("github").unwrap();
        let s = settings("github", on(&[HIVRA]));
        assert_eq!(allowed(&s, github, "m1", &[HIVRA.into()]), Ok(()));
        assert_eq!(
            allowed(&s, github, "m1", &[HIVRA.into(), NIBBII.into()]),
            Err(Denied::ProjectOff(NIBBII.into()))
        );
        assert_eq!(
            allowed(&s, github, "m1", &[NIBBII.into()]),
            Err(Denied::ProjectOff(NIBBII.into()))
        );
        // Not in any project: only when allowed outside projects.
        assert_eq!(allowed(&s, github, "m1", &[]), Err(Denied::OutsideOff));
        let s = settings("github", on(&[OUTSIDE]));
        assert_eq!(allowed(&s, github, "m1", &[]), Ok(()));
        assert_eq!(
            allowed(&s, github, "m1", &[HIVRA.into()]),
            Err(Denied::ProjectOff(HIVRA.into()))
        );
        let s = settings("github", on(&[EVERYWHERE]));
        assert_eq!(allowed(&s, github, "m1", &[]), Ok(()));
        assert_eq!(
            allowed(&s, github, "m1", &[HIVRA.into(), NIBBII.into()]),
            Ok(())
        );
    }

    #[test]
    fn nothing_is_allowed_by_default() {
        let github = catalog::entry("github").unwrap();
        assert_eq!(
            allowed(&Settings::default(), github, "m1", &[HIVRA.into()]),
            Err(Denied::NotSignedIn)
        );
        // Signed in but given to nobody yet.
        let s = settings("github", on(&[]));
        assert!(allowed(&s, github, "m1", &[HIVRA.into()]).is_err());
        assert!(allowed(&s, github, "m1", &[]).is_err());
        // Signed out keeps its projects but allows nothing.
        let mut state = on(&[EVERYWHERE]);
        state.signed_in = false;
        assert_eq!(
            allowed(&settings("github", state), github, "m1", &[]),
            Err(Denied::NotSignedIn)
        );
    }

    #[test]
    fn per_mono_choices_narrow_what_the_project_allows() {
        let github = catalog::entry("github").unwrap();
        let mut s = settings("github", on(&[HIVRA]));
        s.monos.insert(
            "m1".into(),
            MonoChoice::All {
                except: vec!["github".into()],
            },
        );
        s.monos.insert(
            "m2".into(),
            MonoChoice::Only {
                ids: vec!["github".into()],
            },
        );
        s.monos
            .insert("m3".into(), MonoChoice::Only { ids: vec![] });
        assert_eq!(
            allowed(&s, github, "m1", &[HIVRA.into()]),
            Err(Denied::MonoOff)
        );
        assert_eq!(allowed(&s, github, "m2", &[HIVRA.into()]), Ok(()));
        assert_eq!(
            allowed(&s, github, "m3", &[HIVRA.into()]),
            Err(Denied::MonoOff)
        );
        // A Mono's own choice never widens past its projects.
        assert_eq!(
            allowed(&s, github, "m2", &[NIBBII.into()]),
            Err(Denied::ProjectOff(NIBBII.into()))
        );
    }

    #[test]
    fn composio_needs_its_switch_and_main_apps_never_do() {
        let composio = catalog::entry("composio").unwrap();
        let mut s = settings("composio", on(&[EVERYWHERE]));
        assert_eq!(allowed(&s, composio, "m", &[]), Err(Denied::NeedsComposio));
        s.composio = true;
        assert_eq!(allowed(&s, composio, "m", &[]), Ok(()));
        let github = catalog::entry("github").unwrap();
        let s = settings("github", on(&[EVERYWHERE]));
        assert!(!s.composio);
        assert_eq!(allowed(&s, github, "m", &[]), Ok(()));
    }

    #[test]
    fn the_file_round_trips_and_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("mc-conn-{}", uuid::Uuid::new_v4()));
        assert_eq!(load(&dir), Settings::default());
        let mut s = settings("github", on(&[HIVRA]));
        s.composio = true;
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path(&dir)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::write(path(&dir), "{not json").unwrap();
        assert_eq!(
            load(&dir),
            Settings::default(),
            "unreadable means nothing on"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
