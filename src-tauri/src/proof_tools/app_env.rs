//! PT-1: the real `run::Env`: proof tools start through the app's own sandboxed runner, the one the project's checks and a
//! brief's check lines use (`verify_stage`), never a runner of their own.
//!
//! Two places a tool runs: a task's own checkout (the gates, the ship check) and the running checker's read-only copy, where
//! every write is denied outside the copy's scratch folder, so a tool's cache and output go there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::firstmate::brief_checks::{Ended, RawRun};
use crate::firstmate::checker_copy::ReadOnlyCopy;

use super::command::{self, Prepared};
use super::run::{Env, PROBE_SECONDS};

/// A program found (or not) on the machine is asked again after this long, so a gate round, a brief and a list don't each
/// start a process for the same answer.
const PROBE_TTL: Duration = Duration::from_secs(60);

type ProbeKey = (PathBuf, Vec<String>);

fn probed() -> &'static Mutex<HashMap<ProbeKey, (Instant, bool)>> {
    static CACHE: OnceLock<Mutex<HashMap<ProbeKey, (Instant, bool)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

enum Where<'a> {
    Checkout {
        main: &'a Path,
        checkout: &'a Path,
    },
    Copy {
        main: &'a Path,
        copy: &'a ReadOnlyCopy,
    },
}

pub struct AppEnv<'a> {
    app: &'a AppHandle,
    at: Where<'a>,
}

impl<'a> AppEnv<'a> {
    /// Tools run in `checkout`, a checkout of the project whose main checkout is `main`.
    pub fn checkout(app: &'a AppHandle, main: &'a Path, checkout: &'a Path) -> AppEnv<'a> {
        AppEnv {
            app,
            at: Where::Checkout { main, checkout },
        }
    }

    /// Tools run in the running checker's read-only copy.
    pub fn copy(app: &'a AppHandle, main: &'a Path, copy: &'a ReadOnlyCopy) -> AppEnv<'a> {
        AppEnv {
            app,
            at: Where::Copy { main, copy },
        }
    }

    fn root(&self) -> &Path {
        match &self.at {
            Where::Checkout { checkout, .. } => checkout,
            Where::Copy { copy, .. } => copy.copy(),
        }
    }

    fn start(&self, id: &str, name: &str, prepared: &Prepared, timeout: u64) -> RawRun {
        match &self.at {
            Where::Checkout { main, checkout } => crate::verify_stage::run_proof_line(
                self.app,
                main,
                checkout,
                id,
                name,
                &prepared.command,
                prepared.env.clone(),
                timeout,
            ),
            Where::Copy { main, copy } => crate::verify_stage::run_copy_line_with(
                self.app,
                main,
                copy,
                &format!("proof-{id}"),
                name,
                &prepared.command,
                timeout,
                prepared.env.clone(),
            ),
        }
    }
}

impl Env for AppEnv<'_> {
    fn probe(&self, argv: &[String]) -> bool {
        let key = (self.root().to_path_buf(), argv.to_vec());
        if let Ok(cache) = probed().lock() {
            if let Some((at, found)) = cache.get(&key) {
                if at.elapsed() < PROBE_TTL {
                    return *found;
                }
            }
        }
        let words: Vec<&str> = argv.iter().map(String::as_str).collect();
        let prepared = command::prepare_argv(&words);
        let ran = self.start("probe", "Is it installed", &prepared, PROBE_SECONDS);
        let found = matches!(ran.ended, Ended::Exited(Some(0)));
        if let Ok(mut cache) = probed().lock() {
            cache.insert(key, (Instant::now(), found));
        }
        found
    }

    fn run(&self, id: &str, name: &str, prepared: &Prepared, timeout_seconds: u64) -> RawRun {
        self.start(id, name, prepared, timeout_seconds)
    }

    fn scratch(&self) -> Option<PathBuf> {
        match &self.at {
            Where::Checkout { .. } => Some(std::env::temp_dir().join("monocode-proof-tools")),
            Where::Copy { copy, .. } => Some(copy.scratch().to_path_buf()),
        }
    }
}
