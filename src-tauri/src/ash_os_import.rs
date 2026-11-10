//! The one-time import from Ash OS (WP-04). Ash OS (`exo-cc-studio`, 127.0.0.1:18767) is retired: the app keeps its
//! projects, Monos per project and kept Pages itself (`local_hub.rs`). On the first start after that change, the
//! webview asks this module once whether an Ash OS still answers and, if it does, what it held; the person then picks
//! Import or Start clean (`src/features/hub/model/localHub/ashOsImport.ts`).
//!
//! Reads only. Three calls are allowed (`ash-hub-projects`, `ash-hub-mono-projects`, `ash-hub-pages`) and nothing is
//! ever written back. The key is read in Rust from Ash OS's token file and never reaches the webview.
//!
//! A dev copy (src/instance.rs) never reaches the live Ash OS: it imports only from a stand-in named by both
//! `MONOCODE_HUB_PORT` and `MONOCODE_HUB_TOKEN_FILE`, and never from port 18767 or the live key file.
//!
//! Ash OS no longer runs as a service, but its record stayed on disk. When the live read gives nothing, the import
//! reads that record instead (`disk.rs`, through a private copy, never the file itself) and answers in exactly the
//! live reads' shape. A dev copy reads only a stand-in record named by `MONOCODE_ASHOS_DB` (and optionally
//! `MONOCODE_ASHOS_PROJECTS` for the curated projects), never Ash OS's real one.

mod disk;

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

const LIVE_PORT: u16 = 18767;
const TOKEN_SUBPATH: &str = ".local/share/exo-cc-studio/token";
const READS: [&str; 3] = ["ash-hub-projects", "ash-hub-mono-projects", "ash-hub-pages"];
const MAX_ANSWER: u64 = 32_000_000;

/// Whether there is anything to ask about, and whether that answer is final.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImportState {
    /// Ash OS answered: its projects, memberships and kept Pages are below.
    Found,
    /// There is no Ash OS to import from, for good: no key file on this Mac, a dev copy with no stand-in named, or a
    /// service there that has no projects call. The app starts clean and never asks again.
    Absent,
    /// Ash OS is set up here but didn't answer this time (not running, timed out, an error or an answer the app
    /// couldn't read, or a pages or memberships read that failed). Nothing is decided: the app tries again next start.
    Unreachable,
}

/// What the import found. Anything but `found` comes with a plain `message`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportFound {
    pub state: ImportState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub projects: Value,
    pub memberships: Value,
    pub pages: Value,
}

impl ImportFound {
    fn not_found(state: ImportState, message: impl Into<String>) -> Self {
        Self {
            state,
            message: Some(message.into()),
            projects: json!([]),
            memberships: json!([]),
            pages: json!([]),
        }
    }
}

/// Why a read gave nothing.
#[derive(Debug, Clone, PartialEq)]
enum ReadError {
    /// No key file: there is no Ash OS here.
    NoKey(String),
    /// The service has no such call (404).
    NoSuchCall(String),
    /// Anything that may pass: not running, a timeout, another error, an unreadable answer.
    Transient(String),
}

impl ReadError {
    fn message(self) -> String {
        match self {
            Self::NoKey(m) | Self::NoSuchCall(m) | Self::Transient(m) => m,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Endpoint {
    port: u16,
    token_path: PathBuf,
}

/// Where to look. `live`: this copy may read the live Ash OS (the daily app). A dev copy needs both overrides and never
/// gets the live port or a live key file (the one under HOME, nor the one under the real home: a dev copy under a
/// temporary HOME still runs as Ash).
fn resolve(
    live: bool,
    port: Option<String>,
    token_file: Option<PathBuf>,
    home: Option<PathBuf>,
    real_home: Option<PathBuf>,
) -> Result<Endpoint, String> {
    let port = port
        .map(|raw| {
            raw.trim()
                .parse::<u16>()
                .map_err(|_| "MONOCODE_HUB_PORT is not a port number.".to_string())
        })
        .transpose()?;
    let live_key = home.map(|home| home.join(TOKEN_SUBPATH));
    if !live {
        let (Some(port), Some(token_path)) = (port, token_file) else {
            return Err("A dev copy imports only from a stand-in (MONOCODE_HUB_PORT and MONOCODE_HUB_TOKEN_FILE).".into());
        };
        if port == LIVE_PORT {
            return Err("A dev copy never reads the live Ash OS on port 18767.".into());
        }
        let real_key = real_home.map(|home| home.join(TOKEN_SUBPATH));
        if [&live_key, &real_key]
            .into_iter()
            .flatten()
            .any(|key| same_file(key, &token_path))
        {
            return Err("A dev copy never reads the live Ash OS key.".into());
        }
        return Ok(Endpoint { port, token_path });
    }
    let token_path = token_file
        .or(live_key)
        .ok_or_else(|| "Ash OS isn't set up on this Mac.".to_string())?;
    Ok(Endpoint {
        port: port.unwrap_or(LIVE_PORT),
        token_path,
    })
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// One read. Only the three import reads are ever sent.
fn read_call(endpoint: &Endpoint, action: &str, payload: Value) -> Result<Value, ReadError> {
    if !READS.contains(&action) {
        return Err(ReadError::NoSuchCall(format!(
            "The import never sends {action}."
        )));
    }
    let token = std::fs::read_to_string(&endpoint.token_path)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| ReadError::NoKey("Ash OS isn't set up on this Mac.".to_string()))?;
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(20))
        .build();
    let response = agent
        .post(&format!("http://127.0.0.1:{}/api/{action}", endpoint.port))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&payload.to_string())
        .map_err(|error| match error {
            ureq::Error::Status(404, _) => {
                ReadError::NoSuchCall(format!("Ash OS has no {action}."))
            }
            ureq::Error::Status(code, _) => {
                ReadError::Transient(format!("Ash OS answered {action} with an error ({code})."))
            }
            ureq::Error::Transport(_) => ReadError::Transient("Ash OS isn't running.".to_string()),
        })?;
    let mut raw = Vec::new();
    response
        .into_reader()
        .take(MAX_ANSWER)
        .read_to_end(&mut raw)
        .map_err(|_| ReadError::Transient("Ash OS's answer was cut short.".to_string()))?;
    let value: Value = serde_json::from_slice(&raw).map_err(|_| {
        ReadError::Transient("Ash OS gave an answer the app couldn't read.".to_string())
    })?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(ReadError::Transient(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Ash OS didn't answer.")
                .to_string(),
        ));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn list(value: &Value, key: &str) -> Value {
    match value.get(key) {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => json!([]),
    }
}

/// An optional read: an older Ash OS without the call (404) gives an empty list; any other failure fails the import.
fn optional(endpoint: &Endpoint, action: &str, key: &str) -> Result<Value, String> {
    match read_call(endpoint, action, json!({})) {
        Ok(value) => Ok(list(&value, key)),
        Err(ReadError::NoSuchCall(_)) => Ok(json!([])),
        Err(error) => Err(error.message()),
    }
}

/// Everything the import takes. Projects (archived ones too, so Ash keeps them), every Mono's projects, and kept Pages
/// only (a removed page stays behind). Never a partial answer: a failed pages or memberships read is `unreachable`,
/// so a later try brings them too.
fn fetch(endpoint: &Endpoint) -> ImportFound {
    let projects = match read_call(
        endpoint,
        "ash-hub-projects",
        json!({"include_archived": true}),
    ) {
        Ok(projects) => projects,
        Err(error @ (ReadError::NoKey(_) | ReadError::NoSuchCall(_))) => {
            return ImportFound::not_found(ImportState::Absent, error.message())
        }
        Err(error) => return ImportFound::not_found(ImportState::Unreachable, error.message()),
    };
    let (memberships, pages) = match (
        optional(endpoint, "ash-hub-mono-projects", "memberships"),
        optional(endpoint, "ash-hub-pages", "pages"),
    ) {
        (Ok(memberships), Ok(pages)) => (memberships, pages),
        (Err(message), _) | (_, Err(message)) => {
            return ImportFound::not_found(ImportState::Unreachable, message)
        }
    };
    ImportFound {
        state: ImportState::Found,
        message: None,
        projects: list(&projects, "projects"),
        memberships,
        pages,
    }
}

/// What the import is pointed at: the live service's overrides and the on-disk record's.
#[derive(Debug, Clone, Default)]
struct Inputs {
    port: Option<String>,
    token_file: Option<PathBuf>,
    db: Option<PathBuf>,
    projects: Option<PathBuf>,
    home: Option<PathBuf>,
    real_home: Option<PathBuf>,
}

/// The live read, then Ash OS's record on disk when the live read found nothing (not running, no key, no such call).
/// The record's answer stands in for the live one in the same shape; with no record the live answer stands, and a
/// record that couldn't be read this time decides nothing (`unreachable`, tried again next start).
fn fetch_all(live: bool, inputs: Inputs) -> ImportFound {
    let found = match resolve(
        live,
        inputs.port,
        inputs.token_file,
        inputs.home.clone(),
        inputs.real_home.clone(),
    ) {
        Ok(endpoint) => fetch(&endpoint),
        // A dev copy with no stand-in, or no home to find the key in: nothing to import from, for good.
        Err(message) => ImportFound::not_found(ImportState::Absent, message),
    };
    if found.state == ImportState::Found {
        return found;
    }
    let Ok(record) = disk::resolve(
        live,
        inputs.db,
        inputs.projects,
        inputs.home,
        inputs.real_home,
    ) else {
        return found;
    };
    match disk::read(&record) {
        Ok(Some(from_disk)) => from_disk,
        Ok(None) => found,
        Err(message) => ImportFound::not_found(ImportState::Unreachable, message),
    }
}

/// `ash_os_import_fetch()`: what Ash OS holds (live, or its record on disk), for the one-time import. Never writes to
/// Ash OS.
#[tauri::command(async)]
pub fn ash_os_import_fetch() -> ImportFound {
    let live = crate::instance::policy().live_ash_os;
    // The record's stand-ins are for a dev copy's tests only: the daily app always reads Ash OS's real record.
    let stand_in = |name: &str| {
        if live {
            None
        } else {
            std::env::var_os(name).map(PathBuf::from)
        }
    };
    fetch_all(
        live,
        Inputs {
            port: std::env::var("MONOCODE_HUB_PORT").ok(),
            token_file: std::env::var_os("MONOCODE_HUB_TOKEN_FILE").map(PathBuf::from),
            db: stand_in("MONOCODE_ASHOS_DB"),
            projects: stand_in("MONOCODE_ASHOS_PROJECTS"),
            home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
            real_home: crate::instance::real_home(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    const SECRET: &str = "stand-in-token-for-tests-only";

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ash-os-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stand-in Ash OS: answers the three reads with fixed data, records every path it was sent.
    fn stand_in(answers: Vec<(&'static str, Value)>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                let mut len = 0usize;
                let mut auth = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = line.trim().to_string();
                    }
                    if head.is_empty() {
                        head = line.clone();
                    }
                }
                let mut body = vec![0; len];
                let _ = reader.read_exact(&mut body);
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(path.clone());
                let reply = if auth != format!("Authorization: Bearer {SECRET}") {
                    (401, json!({"ok": false, "error": "bad key"}))
                } else {
                    match answers
                        .iter()
                        .find(|(name, _)| path == format!("/api/{name}"))
                    {
                        // A result of {"status": N} answers that HTTP status instead (a stand-in having a bad moment).
                        Some((_, result)) => match result.get("status").and_then(Value::as_u64) {
                            Some(code) => (code as u16, json!({"ok": false, "error": "busy"})),
                            None => (200, json!({"ok": true, "result": result})),
                        },
                        None => (404, json!({"ok": false, "error": "Unknown endpoint"})),
                    }
                };
                let body = reply.1.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.0,
                    body.len(),
                    body
                );
            }
        });
        (port, seen)
    }

    #[test]
    fn imports_projects_memberships_and_kept_pages_from_a_stand_in() {
        let dir = temp_dir();
        let token = dir.join("token");
        std::fs::write(&token, SECRET).unwrap();
        let (port, seen) = stand_in(vec![
            (
                "ash-hub-projects",
                json!({"projects": [{"id": "exo", "name": "EXO game", "folder": "/tmp/exo"}], "seq": 4}),
            ),
            (
                "ash-hub-mono-projects",
                json!({"memberships": [{"monoId": "ed", "projectId": "exo", "role": "lead"}]}),
            ),
            (
                "ash-hub-pages",
                json!({"pages": [{"id": "pg-1", "projectId": "exo", "state": "kept"}]}),
            ),
        ]);
        // A dev copy under a temporary HOME, pointed at the stand-in.
        let endpoint = resolve(
            false,
            Some(port.to_string()),
            Some(token),
            Some(dir.clone()),
            None,
        )
        .unwrap();
        let found = fetch(&endpoint);
        assert_eq!(found.state, ImportState::Found, "{found:?}");
        assert_eq!(found.projects[0]["id"], "exo");
        assert_eq!(found.memberships[0]["monoId"], "ed");
        assert_eq!(found.pages[0]["id"], "pg-1");
        // Reads only: exactly the three import calls, nothing else.
        let paths = seen.lock().unwrap().clone();
        assert_eq!(
            paths,
            vec![
                "/api/ash-hub-projects",
                "/api/ash-hub-mono-projects",
                "/api/ash-hub-pages"
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_old_service_with_only_projects_still_imports_them() {
        let dir = temp_dir();
        let token = dir.join("token");
        std::fs::write(&token, SECRET).unwrap();
        let (port, _) = stand_in(vec![(
            "ash-hub-projects",
            json!({"projects": [{"id": "exo"}]}),
        )]);
        let endpoint = resolve(false, Some(port.to_string()), Some(token), None, None).unwrap();
        let found = fetch(&endpoint);
        assert_eq!(found.state, ImportState::Found);
        assert_eq!(found.memberships, json!([]));
        assert_eq!(found.pages, json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bad_moment_is_not_final_and_never_a_partial_import() {
        let dir = temp_dir();
        let token = dir.join("token");
        std::fs::write(&token, SECRET).unwrap();
        let projects = ("ash-hub-projects", json!({"projects": [{"id": "exo"}]}));
        let endpoint_for = |port: u16| {
            resolve(
                false,
                Some(port.to_string()),
                Some(token.clone()),
                None,
                None,
            )
            .unwrap()
        };
        // Projects answer, pages fail with a 500: the whole import waits for next time (no projects without their pages).
        let (port, _) = stand_in(vec![
            projects.clone(),
            ("ash-hub-mono-projects", json!({"memberships": []})),
            ("ash-hub-pages", json!({"status": 500})),
        ]);
        let found = fetch(&endpoint_for(port));
        assert_eq!(found.state, ImportState::Unreachable, "{found:?}");
        assert_eq!(found.projects, json!([]));
        // The same for memberships.
        let (port, _) = stand_in(vec![
            projects.clone(),
            ("ash-hub-mono-projects", json!({"status": 503})),
        ]);
        assert_eq!(fetch(&endpoint_for(port)).state, ImportState::Unreachable);
        // Projects themselves failing: not final either.
        let (port, _) = stand_in(vec![("ash-hub-projects", json!({"status": 502}))]);
        assert_eq!(fetch(&endpoint_for(port)).state, ImportState::Unreachable);
        // A service with no projects call at all (404) is not an Ash OS to import from: final.
        let (port, _) = stand_in(vec![]);
        assert_eq!(fetch(&endpoint_for(port)).state, ImportState::Absent);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_answering_is_not_final_and_no_key_is() {
        let dir = temp_dir();
        let token = dir.join("token");
        std::fs::write(&token, SECRET).unwrap();
        let free = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let endpoint = resolve(
            false,
            Some(free.to_string()),
            Some(token.clone()),
            None,
            None,
        )
        .unwrap();
        // Set up here but not running: nothing is decided, the app tries again next start.
        let found = fetch(&endpoint);
        assert_eq!(found.state, ImportState::Unreachable);
        assert_eq!(found.projects, json!([]));
        // No key file: there is no Ash OS here, for good.
        std::fs::remove_file(&token).unwrap();
        assert_eq!(fetch(&endpoint).state, ImportState::Absent);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_dev_copy_never_reaches_the_live_ash_os() {
        let home = temp_dir();
        let live_key = home.join(TOKEN_SUBPATH);
        std::fs::create_dir_all(live_key.parent().unwrap()).unwrap();
        std::fs::write(&live_key, SECRET).unwrap();
        // No overrides: off.
        assert!(resolve(false, None, None, Some(home.clone()), None).is_err());
        // The live port: refused.
        assert!(resolve(
            false,
            Some("18767".into()),
            Some(home.join("t")),
            Some(home.clone()),
            None
        )
        .is_err());
        // The live key, under HOME or the real home: refused.
        assert!(resolve(
            false,
            Some("4000".into()),
            Some(live_key.clone()),
            Some(home.clone()),
            None
        )
        .is_err());
        assert!(resolve(
            false,
            Some("4000".into()),
            Some(live_key.clone()),
            None,
            Some(home.clone())
        )
        .is_err());
        // The daily app reads the live one.
        let daily = resolve(true, None, None, Some(home.clone()), None).unwrap();
        assert_eq!(
            daily,
            Endpoint {
                port: LIVE_PORT,
                token_path: live_key
            }
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn only_the_three_reads_are_ever_sent() {
        let endpoint = Endpoint {
            port: 1,
            token_path: PathBuf::from("/nonexistent"),
        };
        for write in [
            "ash-hub-project-create",
            "ash-hub-page-update",
            "ash-hub-answer",
        ] {
            assert!(read_call(&endpoint, write, json!({}))
                .unwrap_err()
                .message()
                .contains("never sends"));
        }
    }

    /// A port nothing listens on.
    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn ash_os_not_running_reads_its_record_on_disk_in_the_live_shape() {
        // The daily app on a Mac where Ash OS is set up (its key is there) but no longer runs; its record stayed.
        let home = temp_dir();
        let key = home.join(TOKEN_SUBPATH);
        std::fs::create_dir_all(key.parent().unwrap()).unwrap();
        std::fs::write(&key, SECRET).unwrap();
        let fixture = disk::tests::Fixture::new(&home);
        drop(fixture.standard());
        let inputs = Inputs {
            port: Some(free_port().to_string()),
            home: Some(home.clone()),
            ..Inputs::default()
        };
        let found = fetch_all(true, inputs.clone());
        assert_eq!(found.state, ImportState::Found, "{found:?}");
        // The same shape the live reads give: every project row carries the live row's fields.
        for project in found.projects.as_array().unwrap() {
            let keys: Vec<&String> = project.as_object().unwrap().keys().collect();
            for field in [
                "id",
                "name",
                "shortName",
                "iconShape",
                "folder",
                "workOwner",
                "status",
            ] {
                assert!(
                    keys.iter().any(|k| *k == field),
                    "{field} missing in {project}"
                );
            }
        }
        assert_eq!(found.projects.as_array().unwrap().len(), 4);
        assert_eq!(found.projects[3]["archived"], true);
        assert_eq!(found.memberships.as_array().unwrap().len(), 6);
        assert_eq!(found.pages.as_array().unwrap().len(), 2);
        // Serialized for the webview exactly as the live answer is.
        let wire = serde_json::to_value(&found).unwrap();
        assert_eq!(wire["state"], "found");
        // No key and no service: the record still answers.
        std::fs::remove_file(&key).unwrap();
        assert_eq!(fetch_all(true, inputs.clone()).state, ImportState::Found);
        // No record either: the live answer stands (no key: absent, for good).
        std::fs::remove_file(fixture.db()).unwrap();
        assert_eq!(fetch_all(true, inputs).state, ImportState::Absent);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_live_answer_wins_over_the_record() {
        let home = temp_dir();
        let token = home.join("token");
        std::fs::write(&token, SECRET).unwrap();
        drop(disk::tests::Fixture::new(&home).standard());
        let (port, _) = stand_in(vec![(
            "ash-hub-projects",
            json!({"projects": [{"id": "live-one"}]}),
        )]);
        let found = fetch_all(
            true,
            Inputs {
                port: Some(port.to_string()),
                token_file: Some(token),
                home: Some(home.clone()),
                ..Inputs::default()
            },
        );
        assert_eq!(found.projects, json!([{"id": "live-one"}]));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_dev_copy_never_reads_the_real_record() {
        // The real record under both HOME and the real home, and the live key beside it.
        let home = temp_dir();
        std::fs::create_dir_all(home.join(TOKEN_SUBPATH).parent().unwrap()).unwrap();
        std::fs::write(home.join(TOKEN_SUBPATH), SECRET).unwrap();
        let real = disk::tests::Fixture::new(&home);
        drop(real.standard());
        let base = Inputs {
            home: Some(home.clone()),
            real_home: Some(home.clone()),
            ..Inputs::default()
        };
        // Nothing named: nothing read.
        let found = fetch_all(false, base.clone());
        assert_eq!(found.state, ImportState::Absent);
        assert_eq!(found.projects, json!([]));
        // The real record named: refused, nothing read.
        let named = Inputs {
            db: Some(real.db()),
            ..base.clone()
        };
        assert_eq!(fetch_all(false, named).projects, json!([]));
        // The same Mac, as the daily app: the real record answers. (So the two above were refusals, not empty reads.)
        // (A free port, so nothing ever reaches a real Ash OS on 18767 from a test.)
        let daily = Inputs {
            port: Some(free_port().to_string()),
            ..base.clone()
        };
        assert_eq!(fetch_all(true, daily).state, ImportState::Found);
        // A stand-in record a test names: read.
        let stand_in = temp_dir();
        let fixture = disk::tests::Fixture::new(&stand_in);
        drop(fixture.standard());
        let found = fetch_all(
            false,
            Inputs {
                db: Some(fixture.db()),
                projects: Some(fixture.checkout.join("projects")),
                ..base
            },
        );
        assert_eq!(found.state, ImportState::Found, "{found:?}");
        assert_eq!(found.projects.as_array().unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(stand_in);
    }

    #[test]
    fn a_record_that_cannot_be_read_decides_nothing() {
        let home = temp_dir();
        let fixture = disk::tests::Fixture::new(&home);
        std::fs::write(fixture.db(), b"not a database at all, just bytes").unwrap();
        let found = fetch_all(
            true,
            Inputs {
                port: Some(free_port().to_string()),
                home: Some(home.clone()),
                ..Inputs::default()
            },
        );
        assert_eq!(found.state, ImportState::Unreachable, "{found:?}");
        let _ = std::fs::remove_dir_all(home);
    }
}
