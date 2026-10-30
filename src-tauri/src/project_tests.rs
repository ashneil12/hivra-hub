//! r88 (Ash, step 4): when a Lead didn't run the tests in the project before its roll-up, the app runs them itself after
//! the last landing, and the Lead's chat gets the "Test run in the project" line. Only the project's own `test` script
//! from its package.json runs (`npm test`), in the project folder itself, never in a worker's copy, and never longer than
//! `TEST_TIMEOUT`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::gates::{run_collected, tail, OUTPUT_MAX};

pub(crate) const TEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTestRun {
    pub command: String,
    pub ok: bool,
    pub output: String,
}

/// The project folder, if it is one the app may run tests in: a real folder, not a worker's copy.
pub(crate) fn project_folder(project: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(project)
        .map_err(|_| "The project folder isn't there.".to_string())?;
    let in_worktrees = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with("-worktrees"));
    if !path.is_dir() || in_worktrees {
        return Err("Tests only run in a project folder itself.".into());
    }
    Ok(path)
}

/// Whether its package.json has a `test` script (npm's placeholder that only fails doesn't count).
pub(crate) fn has_test_script(folder: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(folder.join("package.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    json.get("scripts")
        .and_then(|s| s.get("test"))
        .and_then(|t| t.as_str())
        .is_some_and(|t| !t.trim().is_empty() && !t.contains("no test specified"))
}

/// Run the project's tests. `Ok(None)`: it has no test script.
#[tauri::command]
pub async fn run_project_tests(project: String) -> Result<Option<ProjectTestRun>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = project_folder(&project)?;
        if !has_test_script(&folder) {
            return Ok(None);
        }
        let mut cmd = Command::new("npm");
        cmd.arg("test").current_dir(&folder).env("CI", "1");
        if let Some(path) = crate::harness::login_shell_path() {
            cmd.env("PATH", path);
        }
        let (ok, output) = run_collected(cmd, TEST_TIMEOUT, "test run");
        Ok(Some(ProjectTestRun {
            command: "npm test".into(),
            ok,
            output: tail(&output, OUTPUT_MAX),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("monocode-ptests-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_a_real_test_script_counts() {
        let dir = temp("script");
        assert!(!has_test_script(&dir));
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#,
        )
        .unwrap();
        assert!(!has_test_script(&dir));
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"test":"node --test"}}"#,
        )
        .unwrap();
        assert!(has_test_script(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_runs_in_a_worker_copy() {
        let root = temp("copy");
        let copy = root.join("tally-worktrees").join("job");
        std::fs::create_dir_all(&copy).unwrap();
        assert!(project_folder(copy.to_str().unwrap()).is_err());
        assert!(project_folder(root.to_str().unwrap()).is_ok());
        assert!(project_folder("/no/such/folder/anywhere").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
