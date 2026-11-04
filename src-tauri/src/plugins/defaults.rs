//! Default plugins (WP-41): plugins Hivra installs and switches on everywhere by itself, once per data folder.
//!
//! Each one is a folder in `src-tauri/plugins/`, copied from a pinned commit of its own repository and embedded in
//! the binary (build.rs), with its pin in `src-tauri/plugins/defaults.json`. On start the app writes the embedded copy
//! to a staging folder, installs it through the registry like any local plugin (so it is checked, can be switched off
//! and leaves no trace when removed), and switches it on everywhere. `<plugins>/defaults.json` remembers which
//! defaults this data folder has been given, so a default the person switched off stays off and one they removed stays
//! removed: it is offered once, on a fresh install and on an existing one alike. Nothing is downloaded.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsutil;
use super::registry::{self, Host, Scope, Source};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/default_plugins.rs"));
}

/// The pins, as committed beside the embedded folders.
const PINS_JSON: &str = include_str!("../../plugins/defaults.json");
/// What this data folder has been given, in `<plugins>/`.
pub const STATE_FILE: &str = "defaults.json";
/// `source.kind` of a plugin installed from the copy the app carries.
pub const SOURCE_KIND: &str = "bundled";

/// One default plugin's pin.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub name: String,
    /// Its folder in `src-tauri/plugins/` (and in the embedded table).
    pub folder: String,
    pub repository: String,
    /// The plugin's folder inside `repository`.
    pub path: String,
    pub commit: String,
    pub version: String,
    pub license: String,
    pub copyright: String,
    /// What of the upstream folder isn't carried, and so isn't installed.
    #[serde(default)]
    pub left_out: Vec<String>,
}

impl Pin {
    /// Where the copy came from, recorded as the installed plugin's source.
    pub fn source(&self) -> Source {
        Source {
            kind: SOURCE_KIND.into(),
            location: format!(
                "{}/tree/{}/{}",
                self.repository.trim_end_matches('/'),
                self.commit,
                self.path
            ),
            pin: Some(self.commit.clone()),
            tag: None,
            path: Some(self.path.clone()),
            registry: None,
        }
    }
}

#[derive(Deserialize)]
struct Pins {
    plugins: Vec<Pin>,
}

pub fn pins() -> Vec<Pin> {
    serde_json::from_str::<Pins>(PINS_JSON)
        .expect("src-tauri/plugins/defaults.json is checked by a test")
        .plugins
}

/// The embedded files of one folder: path inside it (with `/`), bytes, executable.
pub fn files(folder: &str) -> impl Iterator<Item = (&'static str, &'static [u8], bool)> + '_ {
    embedded::FILES
        .iter()
        .filter(move |(f, ..)| *f == folder)
        .map(|(_, path, bytes, exec)| (*path, *bytes, *exec))
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Each default this data folder has been given, by name, with the commit it was given at.
    #[serde(default)]
    offered: BTreeMap<String, String>,
}

fn read_state(host: &Host) -> Result<State, String> {
    let path = host.root.join(STATE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} can't be read: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(format!("{} can't be read: {e}", path.display())),
    }
}

fn write_state(host: &Host, state: &State) -> Result<(), String> {
    std::fs::create_dir_all(&host.root).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&host.root.join(STATE_FILE), text.as_bytes())
}

/// What happened to one default on this start.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Outcome {
    /// Installed from the copy the app carries and switched on everywhere.
    Installed { name: String },
    /// Given before: left exactly as the person has it (on, off or removed).
    AlreadyGiven { name: String },
    /// The person had installed a plugin by this name themselves: left as it is.
    TheirOwn { name: String },
    /// Didn't work this time; the next start tries again.
    Failed { name: String, why: String },
}

/// Give this data folder every default it hasn't been given yet. Safe to run on every start.
pub fn ensure(host: &Host) -> Vec<Outcome> {
    pins().iter().map(|pin| ensure_one(host, pin)).collect()
}

fn ensure_one(host: &Host, pin: &Pin) -> Outcome {
    let name = pin.name.clone();
    let failed = |why: String| Outcome::Failed {
        name: name.clone(),
        why,
    };
    let mut state = match read_state(host) {
        Ok(state) => state,
        Err(why) => return failed(why),
    };
    if state.offered.contains_key(&pin.name) {
        return Outcome::AlreadyGiven { name };
    }
    let installed = match registry::read(host) {
        Ok(registry) => registry.plugins.get(&pin.name).cloned(),
        Err(why) => return failed(why),
    };
    let outcome = match installed {
        // The person's own plugin by this name: never replaced or switched on.
        Some(entry) if entry.source.kind != SOURCE_KIND => Outcome::TheirOwn { name: name.clone() },
        // A start that installed it but stopped before switching it on (or before remembering it).
        Some(_) => match registry::enable(host, &pin.name, &Scope::Global) {
            Ok(_) => Outcome::Installed { name: name.clone() },
            Err(why) => return failed(why),
        },
        None => match install(host, pin) {
            Ok(()) => Outcome::Installed { name: name.clone() },
            Err(why) => return failed(why),
        },
    };
    state.offered.insert(pin.name.clone(), pin.commit.clone());
    if let Err(why) = write_state(host, &state) {
        return failed(why);
    }
    outcome
}

fn install(host: &Host, pin: &Pin) -> Result<(), String> {
    let staging = host
        .root
        .join(format!(".default-{}-{}", pin.folder, uuid::Uuid::new_v4()));
    let result = unpack(pin, &staging).and_then(|dir| {
        registry::install_local(host, &dir, pin.source())?;
        registry::enable(host, &pin.name, &Scope::Global)?;
        Ok(())
    });
    let _ = fsutil::remove_tree(&staging);
    result
}

/// Write the embedded copy of `pin` under `staging`; returns the plugin's folder.
pub fn unpack(pin: &Pin, staging: &Path) -> Result<PathBuf, String> {
    let dir = staging.join(&pin.folder);
    let mut any = false;
    for (rel, bytes, executable) in files(&pin.folder) {
        any = true;
        let path = rel
            .split('/')
            .fold(dir.clone(), |path, part| path.join(part));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("{} couldn't be made: {e}", parent.display()))?;
        }
        std::fs::write(&path, bytes)
            .map_err(|e| format!("{} couldn't be written: {e}", path.display()))?;
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        let _ = executable;
    }
    if !any {
        return Err(format!("The app carries no copy of \"{}\".", pin.name));
    }
    Ok(dir)
}

/// On start, in the background: give this data folder its defaults. Failures are logged and tried again next start.
pub fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let host = match super::host(app) {
        Ok(host) => host,
        Err(why) => {
            eprintln!("default plugins: no plugin folder: {why}");
            return;
        }
    };
    std::thread::spawn(move || {
        for outcome in ensure(&host) {
            match outcome {
                Outcome::Failed { name, why } => {
                    eprintln!("default plugin {name} wasn't installed: {why}")
                }
                Outcome::Installed { name } => eprintln!("default plugin {name} installed"),
                _ => {}
            }
        }
    });
}
