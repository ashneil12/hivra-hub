//! Review r7 repro for PR #208 (WP-178), red at e0efac876.

use super::*;

/// MED (MED-A residue): the audit's starts are `Command::new`, `.spawn()`, `.output()`, `.status()` and five runner
/// names. A start through a library is not seen. `open::that` and `open::that_detached` start `/usr/bin/open`, a
/// LaunchServices launch the agent profile itself refuses (`deny lsopen`), and `CommandExt::exec` replaces the
/// process. `fs.rs open_path_with_default_app` hands an agent-written path to `open::that` on Ash's "Open with
/// default app": a `.command` file runs in Terminal and an unquarantined `.app` launches, outside the sandbox. It is
/// neither wrapped nor explained, because the audit never lists it.
#[test]
fn a_start_through_the_open_crate_or_exec_is_still_listed() {
    let fixture = r#"
        fn opened(path: &str) {
            let _ = open::that(path);
        }
        fn detached(url: &str) {
            let _ = open::that_detached(url);
        }
        fn replaced(mut command: std::process::Command) {
            let _ = command.exec();
        }
    "#;
    let mut names: Vec<String> = classify("fixture.rs", fixture)
        .into_iter()
        .filter(|site| !site.wrapped)
        .map(|site| site.func)
        .collect();
    names.sort();
    names.dedup();
    assert_eq!(
        names,
        vec![
            "detached".to_string(),
            "opened".to_string(),
            "replaced".to_string()
        ],
        "a start through the open crate or exec is not seen by the audit"
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let sites = collect(&root);
    assert!(
        sites
            .iter()
            .any(|site| site.file == "fs.rs" && site.func == "open_path_with_default_app"),
        "fs.rs open_path_with_default_app opens an agent-written path with LaunchServices and is not listed"
    );
}
