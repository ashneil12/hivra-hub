//! PT-6: the spec parts of a brief: validation, reading a Markdown spec, the brief's context, the done check's findings,
//! the commit-order caveat and the verdict model's section.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;
use crate::delegations::{record, RecordInput};
use crate::firstmate::brief_checks::{keep, state_of, BriefRound, KeepInput};
use crate::session_store::SessionStore;

// ---- helpers --------------------------------------------------------------------------------------------------------------

/// A scratch folder with a space and a non-ASCII letter in its name, removed when dropped.
struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Tmp {
        let dir =
            std::env::temp_dir().join(format!("hivra pt6 café {tag} {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    fn with(tag: &str, files: &[(&str, &str)]) -> Tmp {
        let tmp = Tmp::new(tag);
        for (path, text) in files {
            tmp.write(path, text);
        }
        tmp
    }

    fn write(&self, path: &str, text: &str) {
        let full = self.0.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text).unwrap();
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn part(file: &str, section: &str, text: &str) -> Value {
    json!({ "file": file, "section": section, "text": text })
}

fn delta(file: &str, section: &str, text: &str) -> SpecDelta {
    SpecDelta {
        file: file.into(),
        section: section.into(),
        text: text.into(),
    }
}

fn parse(parts: Value) -> Result<Vec<SpecDelta>, String> {
    parse_deltas(&parts)
}

fn changed(path: &str, before: Option<&str>, after: Option<&str>) -> ChangedFile {
    ChangedFile {
        path: path.into(),
        before: before.map(str::to_string),
        after: after.map(str::to_string),
    }
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = crate::git_cmd::git()
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

const AUTH: &str = "---\ntitle: Auth\npaths: src/auth\n---\n# Auth\n\nIntro.\n\n## Login flow\nThe person signs in with an email and a code.\n\n### Detail\nA wrong code is refused.\n\n## Logout\nThe person signs out everywhere.\n";

// ---- validation: the file ---------------------------------------------------------------------------------------------------

#[test]
fn a_spec_file_is_one_markdown_file_directly_under_a_spec_folder() {
    for good in [
        "docs/spec/auth.md",
        "docs/specs/auth.md",
        "SPEC.md",
        "./docs/spec/auth.md",
        "docs\\spec\\auth.md",
        "docs/spec/login-flow.md",
        "docs/spec/café.md",
        "docs/spec/shipping_confidence.md",
    ] {
        assert!(spec_file(good).is_ok(), "{good}: {:?}", spec_file(good));
    }
    assert_eq!(
        spec_file("./docs\\spec//auth.md").unwrap(),
        "docs/spec/auth.md"
    );
    for (bad, says) in [
        ("../docs/spec/a.md", "leaves the project"),
        ("docs/spec/../../x.md", "leaves the project"),
        ("docs/spec/../x.md", "leaves the project"),
        ("/etc/passwd", "isn't inside the project"),
        ("C:\\x\\a.md", "isn't inside the project"),
        ("~/docs/spec/a.md", "isn't inside the project"),
        ("docs/spec/a/b.md", "sub-folder"),
        ("docs/spec/a.txt", "isn't a Markdown file"),
        ("docs/spec/a", "isn't a Markdown file"),
        ("docs/spec/README.md", "the index"),
        ("docs/spec/readme.md", "the index"),
        ("docs/specs/README.md", "the index"),
        ("src/app.md", "isn't a spec file"),
        ("docs/specification/a.md", "isn't a spec file"),
        ("docs/spec", "isn't a spec file"),
        ("spec.md", "isn't a spec file"),
        ("docs/spec/login flow.md", "no spaces"),
        ("docs/spec/con.md", "reserved on Windows"),
        ("docs/spec/LPT1.md", "reserved on Windows"),
        ("docs/spec/.hidden.md", "start or end with a dot"),
        ("docs/spec/a?.md", "isn't allowed in a file name"),
        ("docs/spec/a:b.md", "isn't allowed in a file name"),
        ("docs/spec/.md", "needs a name"),
        ("docs/spec/a\u{0}b.md", "control character"),
        ("", "Name a file or folder"),
    ] {
        let error = spec_file(bad).unwrap_err();
        assert!(error.contains(says), "{bad:?}: {error}");
    }
    // The file's name is at most 80 characters.
    assert!(spec_file(&format!("docs/spec/{}.md", "a".repeat(80))).is_ok());
    assert!(spec_file(&format!("docs/spec/{}.md", "a".repeat(81))).is_err());
}

// ---- validation: the part and the list --------------------------------------------------------------------------------------

#[test]
fn spec_parts_are_at_most_three_and_closed_to_file_section_and_text() {
    assert_eq!(parse(Value::Null).unwrap(), Vec::new());
    assert_eq!(parse(json!([])).unwrap(), Vec::new());
    let one = parse(json!([part(
        "docs/spec/auth.md",
        "Login flow",
        "The person signs in."
    )]))
    .unwrap();
    assert_eq!(
        one,
        vec![delta(
            "docs/spec/auth.md",
            "Login flow",
            "The person signs in."
        )]
    );
    let three: Vec<Value> = ["A", "B", "C"]
        .iter()
        .map(|name| part("docs/spec/auth.md", name, "x"))
        .collect();
    assert_eq!(parse(Value::Array(three.clone())).unwrap().len(), 3);
    let mut four = three;
    four.push(part("docs/spec/auth.md", "D", "x"));
    assert!(parse(Value::Array(four))
        .unwrap_err()
        .contains("at most 3 spec parts"));
    for (value, says) in [
        (json!("docs/spec/a.md"), "must be a list"),
        (json!({}), "must be a list"),
        (
            json!(["x"]),
            "Spec part 1: it must be {file, section, text}",
        ),
        (
            json!([{ "file": "docs/spec/a.md", "section": "A", "text": "x", "passes": true }]),
            "\"passes\" isn't one",
        ),
        (
            json!([{ "file": "docs/spec/a.md", "section": "A" }]),
            "text must be text",
        ),
        (
            json!([{ "file": 7, "section": "A", "text": "x" }]),
            "file must be text",
        ),
        (
            json!([{ "section": "A", "text": "x" }]),
            "file must be text",
        ),
        (
            json!([part("docs/spec/a.md", "A", "x"), part("../x.md", "A", "x")]),
            "Spec part 2",
        ),
    ] {
        let error = parse(value.clone()).unwrap_err();
        assert!(error.contains(says), "{value}: {error}");
    }
    // A bad file is named with its place in the list, and says what is wrong with it.
    let error = parse(json!([part("../x.md", "A", "x")])).unwrap_err();
    assert!(
        error.starts_with("Spec part 1: ") && error.contains("leaves the project"),
        "{error}"
    );
}

#[test]
fn a_section_is_named_once_a_file_may_carry_several_sections() {
    assert!(parse(json!([
        part("docs/spec/auth.md", "Login flow", "a"),
        part("docs/spec/auth.md", "Logout", "b"),
        part("docs/spec/billing.md", "Login flow", "c"),
    ]))
    .is_ok());
    // The same id however it is spelled: case, spacing, the folder's separators.
    let error = parse(json!([
        part("docs/spec/auth.md", "Login flow", "a"),
        part("docs\\spec\\AUTH.md", "login   FLOW", "b"),
    ]))
    .unwrap_err();
    assert!(
        error.contains("Spec part 2") && error.contains("named twice"),
        "{error}"
    );
}

#[test]
fn a_section_is_one_line_the_name_of_one_heading() {
    let ok = parse(json!([part("docs/spec/a.md", "  Login   flow  ", "x")])).unwrap();
    assert_eq!(ok[0].section, "Login flow", "whitespace collapsed");
    for (name, says) in [
        ("", "needs the section's name"),
        ("   ", "needs the section's name"),
        ("Login\nflow", "one line"),
        ("Login\r\nflow", "one line"),
        ("## Login flow", "without the `#` marks"),
        ("#Login", "without the `#` marks"),
    ] {
        let error = parse(json!([part("docs/spec/a.md", name, "x")])).unwrap_err();
        assert!(error.contains(says), "{name:?}: {error}");
    }
    let long = "n".repeat(SECTION_MAX + 1);
    assert!(parse(json!([part("docs/spec/a.md", &long, "x")]))
        .unwrap_err()
        .contains("longer than 120"));
    assert!(parse(json!([part(
        "docs/spec/a.md",
        &"n".repeat(SECTION_MAX),
        "x"
    )]))
    .is_ok());
}

#[test]
fn the_text_is_the_sections_body_capped_at_4000_characters() {
    let ok = |text: &str| parse(json!([part("docs/spec/a.md", "A", text)]));
    // Characters, not bytes: 4,000 two-byte letters are fine.
    assert!(ok(&"é".repeat(TEXT_MAX)).is_ok());
    assert!(ok(&"é".repeat(TEXT_MAX + 1))
        .unwrap_err()
        .contains("longer than 4000"));
    assert!(ok("").unwrap_err().contains("must read"));
    assert!(ok("  \n\t ").unwrap_err().contains("must read"));
    assert!(ok("x\0y").unwrap_err().contains("null character"));
    // Line endings are read as one: CRLF and lone CR become LF, and the ends are trimmed.
    assert_eq!(
        ok("  one\r\ntwo\rthree \n").unwrap()[0].text,
        "one\ntwo\nthree"
    );
}

#[test]
fn a_heading_that_would_split_the_section_is_refused_and_its_own_heading_is_taken_off() {
    let ok = |text: &str| parse(json!([part("docs/spec/a.md", "Login flow", text)]));
    // Sent with its own heading (any spacing and case), it is taken off the top.
    assert_eq!(
        ok("## Login flow\nThe person signs in.").unwrap()[0].text,
        "The person signs in."
    );
    assert_eq!(ok("##  login FLOW ##\r\nBody").unwrap()[0].text, "Body");
    // A heading with nothing under it says nothing.
    assert!(ok("## Login flow").unwrap_err().contains("must read"));
    // Another `##` or a `#` would end the section early.
    assert!(ok("Body\n## Another")
        .unwrap_err()
        .contains("no `#` or `##` heading"));
    assert!(ok("# Title\nBody")
        .unwrap_err()
        .contains("no `#` or `##` heading"));
    assert!(ok("## Other section\nBody")
        .unwrap_err()
        .contains("no `#` or `##` heading"));
    // `###` is a part of the section, and a `## ` in a code block is code.
    assert!(ok("Body\n### Detail\nMore").is_ok());
    assert!(ok("Body\n```sh\n## a comment\n```\nMore").is_ok());
    assert!(ok("Body\n~~~\n# a comment\n~~~").is_ok());
    // Four spaces make it indented code, and `##x` is no heading.
    assert!(ok("Body\n    ## indented\n##x").is_ok());
    // A text is a section's body, never a file: a rule (`---`) at its top is no front matter hiding a heading between two.
    assert!(ok("---\n## Sneaky\n---\nBody")
        .unwrap_err()
        .contains("no `#` or `##` heading"));
    assert!(ok("---\nBody\n---\nMore").is_ok());
}

#[test]
fn refusing_an_absent_or_good_spec_is_no_refusal() {
    assert!(refuse_bad_spec(None).is_ok());
    assert!(refuse_bad_spec(Some(&Value::Null)).is_ok());
    assert!(refuse_bad_spec(Some(&json!([part("docs/spec/a.md", "A", "x")]))).is_ok());
    assert!(refuse_bad_spec(Some(&json!(7))).is_err());
}

// ---- reading Markdown ---------------------------------------------------------------------------------------------------------

#[test]
fn a_section_runs_to_the_next_heading_of_its_level_or_above_and_keeps_its_parts() {
    assert_eq!(
        find_section(AUTH, "Login flow").as_deref(),
        Some(
            "The person signs in with an email and a code.\n\n### Detail\nA wrong code is refused."
        )
    );
    assert_eq!(
        find_section(AUTH, "Logout").as_deref(),
        Some("The person signs out everywhere.")
    );
    // Case and spacing in the name are not part of the id.
    assert_eq!(
        find_section(AUTH, "  login   FLOW "),
        find_section(AUTH, "Login flow")
    );
    // A title (`#`) is no section, a part (`###`) is not one either, and a missing name is none.
    assert_eq!(find_section(AUTH, "Auth"), None);
    assert_eq!(find_section(AUTH, "Detail"), None);
    assert_eq!(find_section(AUTH, "Nope"), None);
    assert_eq!(find_section("", "A"), None);
    // The front matter is no heading source: a `## ` there isn't a section.
    assert_eq!(find_section("---\n## Fake\n---\n## Real\nx", "Fake"), None);
    assert_eq!(
        find_section("---\n## Fake\n---\n## Real\nx", "Real").as_deref(),
        Some("x")
    );
}

#[test]
fn a_title_ends_the_section_before_it() {
    assert_eq!(
        find_section("## A\nbody\n# Next title\nmore\n## B\nb", "A").as_deref(),
        Some("body")
    );
}

#[test]
fn code_blocks_hide_headings_and_inline_backticks_open_nothing() {
    let doc = "## A\n```sh\n## not a heading\n```\nafter\n## B\nb";
    assert_eq!(
        find_section(doc, "A").as_deref(),
        Some("```sh\n## not a heading\n```\nafter")
    );
    assert_eq!(find_section(doc, "not a heading"), None);
    let tilde = "## A\n~~~\n## nope\n~~~\nafter\n## B\nb";
    assert_eq!(
        find_section(tilde, "A").as_deref(),
        Some("~~~\n## nope\n~~~\nafter")
    );
    // A fence of one kind is not closed by the other.
    let mixed = "## A\n```\n~~~\n## still code\n```\nout\n## B\nb";
    assert_eq!(
        find_section(mixed, "A").as_deref(),
        Some("```\n~~~\n## still code\n```\nout")
    );
    // Three backticks on one line with text after them on the line are inline code.
    let inline = "## A\n```code``` in a line\n## B\nb";
    assert_eq!(
        find_section(inline, "A").as_deref(),
        Some("```code``` in a line")
    );
    assert_eq!(find_section(inline, "B").as_deref(), Some("b"));
}

#[test]
fn headings_are_read_the_way_markdown_reads_them() {
    // CRLF, closing hashes, a `#` that is part of the name, a section with nothing in it, the last section.
    assert_eq!(
        find_section("## A\r\nline one\r\n## B\r\nx\r\n", "A").as_deref(),
        Some("line one")
    );
    assert_eq!(
        find_section("## Login ##\nx", "Login").as_deref(),
        Some("x")
    );
    assert_eq!(
        find_section("## Learn C#\nx", "Learn C#").as_deref(),
        Some("x")
    );
    assert_eq!(find_section("## A\n## B\nb", "A").as_deref(), Some(""));
    assert_eq!(find_section("## A\nlast", "A").as_deref(), Some("last"));
    // The first of two sections with one name is the section.
    assert_eq!(
        find_section("## A\nfirst\n## A\nsecond", "A").as_deref(),
        Some("first")
    );
    // Not headings: no space after the marks, four spaces in, seven marks.
    assert_eq!(find_section("##A\nx\n## B\nb", "A"), None);
    assert_eq!(find_section("    ## A\nx", "A"), None);
    assert_eq!(find_section("####### A\nx", "A"), None);
    // Up to three spaces of indent is still a heading; a byte order mark is ignored.
    assert_eq!(find_section("   ## A\nx", "A").as_deref(), Some("x"));
    assert_eq!(find_section("\u{feff}## A\nx", "A").as_deref(), Some("x"));
}

#[test]
fn the_text_must_be_in_the_section_with_whitespace_read_as_one_space() {
    let section = "The person signs in\nwith an email   and a code.";
    assert!(holds(
        section,
        "The person signs in with an email and a code."
    ));
    assert!(holds(section, "with an email and"));
    assert!(holds("  a \t b\r\n c ", "a b c"));
    // Words and case still count.
    assert!(!holds(section, "the person signs in"));
    assert!(!holds(section, "The person signs out"));
    assert!(!holds("", "x"));
    // Nothing wanted is in everything: a part's text is never empty (validation), so this never decides a round.
    assert!(holds("anything", ""));
}

#[test]
fn a_files_paths_line_names_the_code_it_covers() {
    let with = |front: &str| format!("---\n{front}\n---\n## A\nx");
    assert_eq!(
        paths_of(&with(
            "paths: src/auth, \"src/login/**\", ../outside, /abs, C:\\x"
        )),
        ["src/auth", "src/login"]
    );
    assert_eq!(
        paths_of(&with("paths: [src/a, 'src/b']")),
        ["src/a", "src/b"]
    );
    assert_eq!(
        paths_of(&with("paths:\n  - src/a\n  - 'src/b'\ntitle: x")),
        ["src/a", "src/b"]
    );
    assert_eq!(
        paths_of(&with("paths: src/a, ./src/a/, src\\a")),
        ["src/a"],
        "one path is one entry"
    );
    assert_eq!(paths_of(&with("title: x")), Vec::<String>::new());
    assert_eq!(paths_of(&with("paths:")), Vec::<String>::new());
    // Only the front matter counts: a `paths:` line in the body, or in front matter that never closes, is text.
    assert_eq!(paths_of("## A\npaths: src/a\n"), Vec::<String>::new());
    assert_eq!(paths_of("---\npaths: src/a\n## A\nx"), Vec::<String>::new());
    assert_eq!(
        paths_of("---\r\npaths: src/a\r\n---\r\n## A\r\nx"),
        ["src/a"],
        "CRLF"
    );
}

// ---- where the spec lives ---------------------------------------------------------------------------------------------------

#[test]
fn a_project_keeps_its_spec_in_docs_spec_unless_it_already_keeps_it_elsewhere() {
    let none = Tmp::new("home-none");
    let home = home_of(none.path());
    assert_eq!(
        (
            home.folder.as_str(),
            home.single_file,
            home.exists,
            home.index
        ),
        ("docs/spec", false, false, false)
    );
    let with_index = Tmp::with(
        "home-index",
        &[
            ("docs/spec/README.md", "# Spec\n"),
            ("docs/spec/a.md", "## A\nx"),
        ],
    );
    let home = home_of(with_index.path());
    assert_eq!(
        (home.folder.as_str(), home.exists, home.index),
        ("docs/spec", true, true)
    );
    let plural = Tmp::with("home-plural", &[("docs/specs/a.md", "## A\nx")]);
    let home = home_of(plural.path());
    assert_eq!(
        (home.folder.as_str(), home.exists, home.index),
        ("docs/specs", true, false)
    );
    let single = Tmp::with("home-single", &[("SPEC.md", "## A\nx")]);
    let home = home_of(single.path());
    assert_eq!(
        (home.folder.as_str(), home.single_file, home.exists),
        ("SPEC.md", true, true)
    );
    // docs/spec wins over docs/specs, and a folder over a root file.
    let both = Tmp::with(
        "home-both",
        &[
            ("docs/spec/a.md", "x"),
            ("docs/specs/a.md", "x"),
            ("SPEC.md", "x"),
        ],
    );
    assert_eq!(home_of(both.path()).folder, "docs/spec");
    let folder_and_file = Tmp::with("home-fw", &[("docs/specs/a.md", "x"), ("SPEC.md", "x")]);
    assert_eq!(home_of(folder_and_file.path()).folder, "docs/specs");
}

#[test]
fn spec_parts_belong_where_the_project_keeps_its_spec() {
    let at = |folder: &str, single: bool, exists: bool| SpecHome {
        folder: folder.into(),
        single_file: single,
        exists,
        index: false,
    };
    let (auth, plural, root) = (
        delta("docs/spec/auth.md", "A", "x"),
        delta("docs/specs/auth.md", "A", "x"),
        delta("SPEC.md", "A", "x"),
    );
    // Where the project already keeps it, the first mate is told where, in words it can act on.
    let said = home_refusal(&at("docs/specs", false, true), std::slice::from_ref(&auth)).unwrap();
    assert!(
        said.contains("keeps its spec in docs/specs/") && said.contains("docs/specs/<area>.md"),
        "{said}"
    );
    assert!(home_refusal(
        &at("docs/specs", false, true),
        std::slice::from_ref(&plural)
    )
    .is_none());
    let said = home_refusal(&at("SPEC.md", true, true), std::slice::from_ref(&auth)).unwrap();
    assert!(said.contains("keeps its spec in SPEC.md"), "{said}");
    assert!(home_refusal(&at("SPEC.md", true, true), std::slice::from_ref(&root)).is_none());
    let said = home_refusal(&at("docs/spec", false, true), std::slice::from_ref(&root)).unwrap();
    assert!(said.contains("docs/spec/"), "{said}");
    // The first brief of a project with none may start it in either folder, but in one place.
    assert!(home_refusal(&at("docs/spec", false, false), std::slice::from_ref(&auth)).is_none());
    assert!(home_refusal(
        &at("docs/spec", false, false),
        std::slice::from_ref(&plural)
    )
    .is_none());
    assert!(
        home_refusal(&at("docs/spec", false, false), &[auth, plural])
            .unwrap()
            .contains("one place")
    );
    assert!(home_refusal(&at("docs/spec", false, false), &[]).is_none());
}

// ---- the brief's context ----------------------------------------------------------------------------------------------------

#[test]
fn a_brief_reads_the_current_section_from_the_project_and_caps_it() {
    let big_file = format!("## Big\n{}\n## Next\nn", "a".repeat(5_000));
    let project = Tmp::with(
        "context",
        &[
            ("docs/spec/auth.md", AUTH),
            ("docs/spec/big.md", big_file.as_str()),
        ],
    );
    let deltas = [
        delta("docs/spec/auth.md", "Login flow", "new"),
        delta("docs/spec/auth.md", "Nope", "new"),
        delta("docs/spec/big.md", "Big", "new"),
        delta("docs/spec/new.md", "Fresh", "new"),
    ];
    let context = context_of(project.path(), &deltas, &[]);
    assert_eq!(context.refusal, None);
    assert_eq!(context.home.folder, "docs/spec");
    let [login, nope, big, fresh] = &context.current[..] else {
        panic!("{:?}", context.current)
    };
    assert!(login.file_found && login.found && !login.cut);
    assert!(
        login
            .text
            .starts_with("The person signs in with an email and a code."),
        "{}",
        login.text
    );
    assert!(
        nope.file_found && !nope.found && nope.text.is_empty(),
        "the file is there, the section isn't"
    );
    assert!(
        big.found && big.cut && big.text.chars().count() == CURRENT_MAX,
        "{}",
        big.text.len()
    );
    assert!(
        !fresh.file_found && !fresh.found,
        "the brief creates this file"
    );
    // Every part in order, naming its file and section.
    assert_eq!(
        context
            .current
            .iter()
            .map(|c| c.section.as_str())
            .collect::<Vec<_>>(),
        ["Login flow", "Nope", "Big", "Fresh"]
    );
    // The index is there for the "Spec" link only when README.md is.
    assert!(!context.home.index);
    project.write("docs/spec/README.md", "# Spec\n");
    assert!(context_of(project.path(), &deltas, &[]).home.index);
}

#[test]
fn context_for_reads_the_folder_a_person_gave_and_takes_windows_paths_in_scope() {
    let project = Tmp::with("context-for", &[("docs/spec/auth.md", AUTH)]);
    let folder = project.path().to_str().unwrap();
    let input = ContextInput {
        deltas: json!([part("docs/spec/auth.md", "Logout", "x")]),
        scope: vec![],
    };
    let context = context_for(folder, &input).unwrap();
    assert_eq!(context.current[0].text, "The person signs out everywhere.");
    // A bad part is refused here too: the command trusts nothing the window sends.
    let bad = ContextInput {
        deltas: json!([part("../x.md", "A", "x")]),
        scope: vec![],
    };
    assert!(context_for(folder, &bad)
        .unwrap_err()
        .starts_with("Spec part 1"));
    // A blank folder is no project.
    assert!(context_for("", &input).is_err());
    // Scope entries are read the way a brief's own paths are: backslashes, `./`, a path outside the project dropped.
    let scoped = ContextInput {
        deltas: Value::Null,
        scope: vec![
            "src\\auth\\login.ts".into(),
            "../outside".into(),
            "/abs".into(),
        ],
    };
    let related = context_for(folder, &scoped).unwrap().related;
    assert_eq!(related.len(), 1);
    assert_eq!(related[0].file, "docs/spec/auth.md");
}

#[test]
fn a_brief_with_no_spec_part_gets_the_files_whose_paths_cover_its_scope_as_context_only() {
    let project = Tmp::with(
        "related",
        &[
            ("docs/spec/auth.md", AUTH),
            (
                "docs/spec/billing.md",
                "---\npaths: src/billing\n---\n## Invoices\nOne per month.\n",
            ),
            (
                "docs/spec/README.md",
                "---\npaths: src/auth\n---\n# Index\n",
            ),
            ("docs/spec/nopaths.md", "## Misc\nx\n"),
        ],
    );
    let scope = |paths: &[&str]| paths.iter().map(|p| p.to_string()).collect::<Vec<_>>();
    // A file in the covered folder: that file, as text without its front matter, in the order of the folder.
    let context = context_of(project.path(), &[], &scope(&["src/auth/login.ts"]));
    assert_eq!(context.current, Vec::new());
    assert_eq!(
        context.related.len(),
        1,
        "the index and a file with no paths line are never context"
    );
    assert_eq!(context.related[0].file, "docs/spec/auth.md");
    assert!(
        context.related[0].text.starts_with("# Auth"),
        "{}",
        context.related[0].text
    );
    assert!(
        !context.related[0].text.contains("paths:"),
        "the front matter is left out"
    );
    assert!(context.related[0].text.contains("## Login flow"));
    // A folder that holds a covered one covers it too, and a file that names a folder inside the scope.
    let wide = context_of(project.path(), &[], &scope(&["src"]));
    assert_eq!(
        wide.related
            .iter()
            .map(|r| r.file.as_str())
            .collect::<Vec<_>>(),
        ["docs/spec/auth.md", "docs/spec/billing.md"]
    );
    // No match, or no scope, no context.
    assert!(context_of(project.path(), &[], &scope(&["docs"]))
        .related
        .is_empty());
    assert!(context_of(project.path(), &[], &[]).related.is_empty());
    // A spec part makes the brief's section the context: the paths match adds nothing.
    let with_part = context_of(
        project.path(),
        &[delta("docs/spec/auth.md", "Logout", "x")],
        &scope(&["src/auth/login.ts"]),
    );
    assert!(with_part.related.is_empty());
    // A project with no spec has no context.
    let empty = Tmp::new("related-none");
    assert!(context_of(empty.path(), &[], &scope(&["src/auth"]))
        .related
        .is_empty());
}

#[test]
fn context_files_are_at_most_three_and_each_is_cut() {
    let mut files: Vec<(String, String)> = (1..=5)
        .map(|n| {
            (
                format!("docs/spec/area{n}.md"),
                format!("---\npaths: src\n---\n## A\n{}\n", "b".repeat(3_000)),
            )
        })
        .collect();
    files.push((
        "docs/spec/area0.md".into(),
        "---\npaths: src\n---\n## A\nshort\n".into(),
    ));
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let project = Tmp::with("related-cap", &refs);
    let related = context_of(project.path(), &[], &["src/x.ts".to_string()]).related;
    assert_eq!(
        related.iter().map(|r| r.file.as_str()).collect::<Vec<_>>(),
        [
            "docs/spec/area0.md",
            "docs/spec/area1.md",
            "docs/spec/area2.md"
        ]
    );
    assert!(!related[0].cut && related[1].cut);
    assert!(related[1].text.chars().count() <= 2_500);
}

#[cfg(unix)]
#[test]
fn a_spec_file_that_is_a_link_out_of_the_project_is_not_read() {
    let outside = Tmp::with(
        "outside",
        &[("secret.md", "## Login flow\nnot the project's\n")],
    );
    let project = Tmp::new("link");
    std::fs::create_dir_all(project.path().join("docs/spec")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.md"),
        project.path().join("docs/spec/auth.md"),
    )
    .unwrap();
    let context = context_of(
        project.path(),
        &[delta("docs/spec/auth.md", "Login flow", "x")],
        &[],
    );
    assert!(!context.current[0].file_found && !context.current[0].found);
    assert!(!context.current[0].text.contains("not the project"));
    // And in the done check: the copy's spec file is a link out, so it can't hold the text.
    let found = findings(
        &[delta(
            "docs/spec/auth.md",
            "Login flow",
            "not the project's",
        )],
        project.path(),
        &[changed("docs/spec/auth.md", Some("a"), Some("b"))],
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(
        found[0].detail.contains("plain file inside the copy"),
        "{}",
        found[0].detail
    );
}

// ---- the done check: findings ------------------------------------------------------------------------------------------------

const WANTED: &str = "The person signs in with an email and a code.";

fn spec_part() -> Vec<SpecDelta> {
    vec![delta("docs/spec/auth.md", "Login flow", WANTED)]
}

#[test]
fn the_spec_file_must_have_changed() {
    let copy = Tmp::with("f-unchanged", &[("docs/spec/auth.md", AUTH)]);
    // Not in the list of changes: the spec wasn't touched, even when the text happens to be there.
    let found = findings(
        &spec_part(),
        copy.path(),
        &[changed("src/auth.ts", Some("a"), Some("b"))],
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].kind, FindingKind::SpecNotUpdated);
    assert_eq!(found[0].file.as_deref(), Some("docs/spec/auth.md"));
    assert!(
        found[0]
            .detail
            .starts_with("docs/spec/auth.md was not changed")
            && found[0].detail.contains("\"Login flow\""),
        "{}",
        found[0].detail
    );
    assert!(found[0].line().starts_with("Spec not updated: "));
    assert!(
        findings(&spec_part(), copy.path(), &[]).len() == 1,
        "no change at all"
    );
    // Listed with the same text on both sides (a mode change) is not a change either.
    let same = findings(
        &spec_part(),
        copy.path(),
        &[changed("docs/spec/auth.md", Some(AUTH), Some(AUTH))],
    );
    assert_eq!(same.len(), 1);
    // Both sides empty is a file too large to read: that says nothing, so the text decides.
    assert!(findings(
        &spec_part(),
        copy.path(),
        &[changed("docs/spec/auth.md", Some(""), Some(""))]
    )
    .is_empty());
    // A changed file counts whatever the case or the separators of its listed path.
    assert!(findings(
        &spec_part(),
        copy.path(),
        &[changed("DOCS\\Spec\\auth.md", Some("x"), Some(AUTH))]
    )
    .is_empty());
    // A new file (no text before) and a changed one both count.
    assert!(findings(
        &spec_part(),
        copy.path(),
        &[changed("docs/spec/auth.md", None, Some(AUTH))]
    )
    .is_empty());
}

#[test]
fn the_section_in_the_workers_copy_must_hold_the_briefs_text() {
    let copy = Tmp::with("f-text", &[("docs/spec/auth.md", AUTH)]);
    let edited = |path: &str| [changed(path, Some("old"), Some(AUTH))];
    assert!(findings(&spec_part(), copy.path(), &edited("docs/spec/auth.md")).is_empty());
    // Whitespace is read as one space: the worker may rewrap the lines.
    let rewrapped = Tmp::with(
        "f-wrap",
        &[(
            "docs/spec/auth.md",
            "## Login flow\r\nThe person   signs in\r\n  with an email and a code.\r\n",
        )],
    );
    assert!(findings(&spec_part(), rewrapped.path(), &edited("docs/spec/auth.md")).is_empty());
    // But not the words: another text, a section without it, no such section, no such file.
    let other = Tmp::with(
        "f-other",
        &[(
            "docs/spec/auth.md",
            "## Login flow\nThe person signs in with a password.\n",
        )],
    );
    let said = findings(&spec_part(), other.path(), &edited("docs/spec/auth.md"));
    assert_eq!(said.len(), 1);
    assert_eq!(
        said[0].detail,
        "The \"Login flow\" section of docs/spec/auth.md doesn't contain the text the brief asked for."
    );
    // The text in a different section doesn't count.
    let elsewhere_file = format!("## Login flow\nold\n## Logout\n{WANTED}\n");
    let elsewhere = Tmp::with("f-else", &[("docs/spec/auth.md", elsewhere_file.as_str())]);
    assert_eq!(
        findings(&spec_part(), elsewhere.path(), &edited("docs/spec/auth.md")).len(),
        1
    );
    let nosection = Tmp::with("f-nosection", &[("docs/spec/auth.md", "## Logout\nx\n")]);
    let said = findings(&spec_part(), nosection.path(), &edited("docs/spec/auth.md"));
    assert!(
        said[0].detail.contains("has no \"Login flow\" section"),
        "{}",
        said[0].detail
    );
    let nofile = Tmp::new("f-nofile");
    let said = findings(&spec_part(), nofile.path(), &edited("docs/spec/auth.md"));
    assert!(
        said[0].detail.contains("isn't in the worker's copy"),
        "{}",
        said[0].detail
    );
}

#[test]
fn each_spec_part_is_judged_on_its_own() {
    let copy = Tmp::with(
        "f-parts",
        &[
            ("docs/spec/auth.md", AUTH),
            ("docs/spec/billing.md", "## Invoices\nOne per year.\n"),
        ],
    );
    let parts = vec![
        delta("docs/spec/auth.md", "Login flow", WANTED),
        delta(
            "docs/spec/auth.md",
            "Logout",
            "The person signs out everywhere.",
        ),
        delta("docs/spec/billing.md", "Invoices", "One per month."),
    ];
    let files = [
        changed("docs/spec/auth.md", Some("x"), Some(AUTH)),
        changed("docs/spec/billing.md", Some("x"), Some("y")),
    ];
    let found = findings(&parts, copy.path(), &files);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(
        found[0]
            .detail
            .contains("\"Invoices\" section of docs/spec/billing.md"),
        "{}",
        found[0].detail
    );
}

// ---- the done check: commit order --------------------------------------------------------------------------------------------

fn commit(files: &[&str]) -> Vec<String> {
    files.iter().map(|f| f.to_string()).collect()
}

#[test]
fn a_git_log_is_read_as_the_files_of_each_commit_oldest_first() {
    let log = "\u{1}aaa\n\ndocs/spec/auth.md\n\u{1}bbb\n\nsrc/a.ts\nsrc/b.ts\n\u{1}ccc\n";
    assert_eq!(
        parse_log(log),
        vec![
            commit(&["docs/spec/auth.md"]),
            commit(&["src/a.ts", "src/b.ts"]),
            commit(&[])
        ]
    );
    assert_eq!(parse_log(""), Vec::<Vec<String>>::new());
    assert_eq!(
        parse_log("\u{1}aaa\r\n\r\nsrc/a.ts\r\n"),
        vec![commit(&["src/a.ts"])],
        "CRLF"
    );
}

#[test]
fn a_spec_committed_first_and_alone_is_the_right_order() {
    let deltas = spec_part();
    assert_eq!(
        order_caveat(
            &deltas,
            &[commit(&["docs/spec/auth.md"]), commit(&["src/auth.ts"])]
        ),
        None
    );
    // The index line and a second spec file in the spec's commit are still the spec.
    assert_eq!(
        order_caveat(
            &deltas,
            &[
                commit(&["docs/spec/auth.md", "docs/spec/README.md"]),
                commit(&["src/auth.ts"])
            ]
        ),
        None
    );
    // More commits after the code's first are not the spec's business.
    assert_eq!(
        order_caveat(
            &deltas,
            &[
                commit(&["docs/spec/auth.md"]),
                commit(&["src/a.ts"]),
                commit(&["docs/spec/auth.md"])
            ]
        ),
        None
    );
}

#[test]
fn a_spec_committed_after_the_code_or_with_it_is_a_caveat() {
    let deltas = spec_part();
    let late = order_caveat(
        &deltas,
        &[commit(&["src/auth.ts"]), commit(&["docs/spec/auth.md"])],
    )
    .unwrap();
    assert!(
        late.starts_with("The spec was changed after the code"),
        "{late}"
    );
    let together = order_caveat(&deltas, &[commit(&["src/auth.ts", "docs/spec/auth.md"])]).unwrap();
    assert!(together.contains("shares a commit with code"), "{together}");
    // A test file is code too: the spec comes before the tests as well.
    assert!(order_caveat(
        &deltas,
        &[
            commit(&["src/auth.test.ts"]),
            commit(&["docs/spec/auth.md"])
        ]
    )
    .is_some());
    // Case and separators don't hide the spec's path.
    assert!(order_caveat(
        &deltas,
        &[commit(&["src/auth.ts"]), commit(&["DOCS\\Spec\\Auth.md"])]
    )
    .is_some());
}

#[test]
fn there_is_no_caveat_when_the_order_cannot_be_judged() {
    let deltas = spec_part();
    // The spec has no commit yet (the committed gate says so), no code was committed, nothing was committed.
    assert_eq!(order_caveat(&deltas, &[commit(&["src/auth.ts"])]), None);
    assert_eq!(
        order_caveat(&deltas, &[commit(&["docs/spec/auth.md"])]),
        None
    );
    assert_eq!(
        order_caveat(
            &deltas,
            &[commit(&["docs/spec/other.md"]), commit(&["src/a.ts"])]
        ),
        None
    );
    assert_eq!(order_caveat(&deltas, &[]), None);
    assert_eq!(order_caveat(&[], &[commit(&["src/a.ts"])]), None);
    // Another spec area's file in front of the code is spec, not code.
    assert_eq!(
        order_caveat(
            &deltas,
            &[
                commit(&["docs/specs/other.md"]),
                commit(&["docs/spec/auth.md"]),
                commit(&["src/a.ts"])
            ]
        ),
        None
    );
}

#[test]
fn the_commits_come_from_the_workers_copy_since_where_it_started() {
    let repo = Tmp::new("log");
    sh(repo.path(), &["init", "-q", "-b", "main"]);
    repo.write("README.md", "start\n");
    sh(repo.path(), &["add", "-A"]);
    sh(repo.path(), &["commit", "-q", "-m", "start"]);
    let base = sh(repo.path(), &["rev-parse", "HEAD"]);
    repo.write("src/auth.ts", "export const a = 1;\n");
    sh(repo.path(), &["add", "-A"]);
    sh(repo.path(), &["commit", "-q", "-m", "code"]);
    repo.write("docs/spec/auth.md", AUTH);
    sh(repo.path(), &["add", "-A"]);
    sh(repo.path(), &["commit", "-q", "-m", "spec"]);
    let commits = commits_since(repo.path(), Some(&base));
    assert_eq!(
        commits,
        vec![commit(&["src/auth.ts"]), commit(&["docs/spec/auth.md"])]
    );
    assert!(order_caveat(&spec_part(), &commits)
        .unwrap()
        .contains("after the code"));
    // Nothing since HEAD, no base, a base git doesn't know, and a folder that isn't a checkout: no commits, no caveat.
    assert!(commits_since(repo.path(), Some("HEAD")).is_empty());
    assert!(commits_since(repo.path(), None).is_empty());
    assert!(commits_since(
        repo.path(),
        Some("0123456789abcdef0123456789abcdef01234567")
    )
    .is_empty());
    let plain = Tmp::new("log-plain");
    assert!(commits_since(plain.path(), Some(&base)).is_empty());
}

// ---- the verdict model's section ------------------------------------------------------------------------------------------------

#[test]
fn the_verdict_prompt_shows_each_section_as_asked_and_as_it_reads_and_asks_for_a_claim_row() {
    let copy = Tmp::with("prompt", &[("docs/spec/auth.md", AUTH)]);
    let deltas = vec![
        delta(
            "docs/spec/auth.md",
            "Login flow",
            "The person signs in with a code.\n### Detail\nNo password.",
        ),
        delta("docs/spec/auth.md", "Gone", "x"),
        delta("docs/spec/new.md", "Fresh", "y"),
    ];
    let text = prompt_section(&deltas, copy.path()).unwrap();
    assert!(text.starts_with("## Spec of record\n"), "{text}");
    assert!(text.contains("Add one claim row for each"), "{text}");
    assert!(
        text.contains("The diff agrees with <file>, <section>"),
        "{text}"
    );
    assert!(text.contains("### docs/spec/auth.md, Login flow"), "{text}");
    // The asked-for text and the copy's current text, both indented so no line of either opens a heading of its own.
    assert!(text.contains("The brief asked it to read:\n    The person signs in with a code.\n    ### Detail\n    No password."), "{text}");
    assert!(
        text.contains(
            "The worker's copy reads now:\n    The person signs in with an email and a code."
        ),
        "{text}"
    );
    assert!(
        text.contains("(the worker's copy has no such section)"),
        "{text}"
    );
    assert!(
        text.contains("(the worker's copy has no such file)"),
        "{text}"
    );
    for line in text.lines() {
        if let Some(level) = line.strip_prefix('#') {
            assert!(
                level.starts_with("# ") || level.starts_with("## "),
                "only the section's own headings are at the margin: {line}"
            );
        }
    }
    assert_eq!(
        text.lines().filter(|line| line.starts_with("### ")).count(),
        3,
        "one heading per part, nothing from the text"
    );
    // No spec part, no section.
    assert_eq!(prompt_section(&[], copy.path()), None);
    // A long text is cut for the model.
    let long = prompt_section(
        &[delta(
            "docs/spec/auth.md",
            "Login flow",
            &"w ".repeat(2_000),
        )],
        copy.path(),
    )
    .unwrap();
    assert!(long.chars().count() < 4_500, "{}", long.len());
}

// ---- the row ---------------------------------------------------------------------------------------------------------------

fn store_with_task() -> (SessionStore, String) {
    let store = SessionStore::open_in_memory().unwrap();
    let id = {
        let mut conn = store.lock_conn().unwrap();
        record(
            &mut conn,
            RecordInput {
                owner_session: "lead".into(),
                request_id: "r1".into(),
                child_session: "w1".into(),
                title: Some("Change login".into()),
                brief: Some("Change login".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap()
        .id
    };
    (store, id)
}

#[test]
fn the_spec_parts_are_kept_with_the_row_once_and_read_back_validated() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    // A row from before, and a brief with no spec part, read as none.
    let state = state_of(&conn, &id).unwrap();
    assert_eq!((state.spec.len(), &state.spec_unreadable), (0, &None));
    let first = KeepInput {
        spec: json!([part(
            "docs/spec/auth.md",
            "Login flow",
            "The person signs in."
        )]),
        ..Default::default()
    };
    assert!(keep(&conn, &id, &first).unwrap());
    let state = state_of(&conn, &id).unwrap();
    assert_eq!(
        state.spec,
        vec![delta(
            "docs/spec/auth.md",
            "Login flow",
            "The person signs in."
        )]
    );
    assert_eq!(BriefRound::from(&state).spec, state.spec);
    // The first keep wins: a retry with other parts changes nothing.
    let again = KeepInput {
        spec: json!([part("docs/spec/other.md", "B", "x")]),
        ..Default::default()
    };
    assert!(!keep(&conn, &id, &again).unwrap());
    assert_eq!(state_of(&conn, &id).unwrap().spec, state.spec);
}

#[test]
fn a_keep_refuses_bad_spec_parts_and_writes_nothing() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    for bad in [
        json!([part("../x.md", "A", "x")]),
        json!([
            part("docs/spec/a.md", "A", "x"),
            part("docs/spec/a.md", "a", "y")
        ]),
        json!(7),
        json!((0..4)
            .map(|n| part("docs/spec/a.md", &format!("S{n}"), "x"))
            .collect::<Vec<_>>()),
    ] {
        let input = KeepInput {
            spec: bad.clone(),
            ..Default::default()
        };
        assert!(keep(&conn, &id, &input).is_err(), "{bad}");
    }
    // Nothing was kept, so a good keep is still the first.
    let good = KeepInput {
        spec: json!([part("docs/spec/a.md", "A", "x")]),
        ..Default::default()
    };
    assert!(keep(&conn, &id, &good).unwrap());
}

#[test]
fn stored_spec_parts_that_cannot_be_read_are_never_read_as_none() {
    let (store, id) = store_with_task();
    let conn = store.lock_conn().unwrap();
    assert!(keep(&conn, &id, &KeepInput::default()).unwrap());
    for damaged in [
        "not json",
        "",
        "{\"file\":\"docs/spec/a.md\"}",
        "[{\"file\":\"../x.md\",\"section\":\"A\",\"text\":\"x\"}]",
        "[{\"file\":\"docs/spec/a.md\",\"section\":\"A\",\"text\":\"x\",\"extra\":1}]",
    ] {
        conn.execute(
            "UPDATE delegations SET brief_spec = ?2 WHERE id = ?1",
            rusqlite::params![id, damaged],
        )
        .unwrap();
        let state = state_of(&conn, &id).unwrap();
        assert!(state.spec.is_empty(), "{damaged}");
        assert_eq!(
            state.spec_unreadable.as_deref(),
            Some("the brief's spec parts couldn't be read"),
            "{damaged}"
        );
        assert!(BriefRound::from(&state).spec_unreadable.is_some());
    }
}

#[test]
fn the_column_is_added_to_a_store_from_before_and_a_second_pass_adds_nothing() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::delegations::ensure_tables(&conn).unwrap();
    let columns = |conn: &rusqlite::Connection| -> i64 {
        conn.prepare(
            "SELECT COUNT(*) FROM pragma_table_info('delegations') WHERE name = 'brief_spec'",
        )
        .unwrap()
        .query_row([], |row| row.get(0))
        .unwrap()
    };
    assert_eq!(columns(&conn), 1);
    // A store from before the column: its rows keep their data, read as a brief with no spec part.
    conn.execute_batch(
        "INSERT INTO delegations (id, owner_session, root_id, child_session, request_id, state, delivery, created_at, updated_at)
           VALUES ('d-old', 'lead', 'd-old', 'w', 'r', 'running', 'pending', 1, 1);
         ALTER TABLE delegations DROP COLUMN brief_spec;",
    )
    .unwrap();
    assert_eq!(columns(&conn), 0);
    crate::delegations::ensure_tables(&conn).unwrap();
    crate::delegations::ensure_tables(&conn).unwrap();
    assert_eq!(columns(&conn), 1, "added once");
    assert_eq!(
        state_of(&conn, "d-old").unwrap(),
        crate::firstmate::brief_checks::BriefState::default()
    );
}

// ---- no other command writes or reads beyond the folder ----------------------------------------------------------------------

// ---- the landed briefs spec_start reads ----------------------------------------------------------------------------------------

fn land(
    conn: &rusqlite::Connection,
    request: &str,
    project: &str,
    state: &str,
    verdict: Option<&str>,
    at: i64,
) {
    conn.execute(
        "INSERT INTO delegations (id, owner_session, root_id, child_session, request_id, project, title, goal, brief, state, gate_verdict, delivery, created_at, updated_at, settled_at)
         VALUES (?1, 'lead', ?1, ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 1, ?9, ?9)",
        rusqlite::params![
            request,
            format!("w-{request}"),
            project,
            format!("Title {request}"),
            format!("Goal {request}"),
            format!("## Intent\nAsk {request}\n\n## Spec\nBuild {request}"),
            state,
            verdict,
            at
        ],
    )
    .unwrap();
}

#[test]
fn the_landed_briefs_are_this_projects_finished_tasks_that_passed_newest_first() {
    let store = SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    land(&conn, "old", "vg-game", "completed", Some("passed"), 10);
    land(&conn, "new", "vg-game", "completed", Some("passed"), 30);
    land(&conn, "unchecked", "vg-game", "completed", None, 20);
    land(&conn, "failed", "vg-game", "completed", Some("failed"), 40);
    land(&conn, "unsure", "vg-game", "completed", Some("unsure"), 41);
    land(&conn, "running", "vg-game", "running", None, 50);
    land(&conn, "cancelled", "vg-game", "cancelled", None, 51);
    land(
        &conn,
        "other",
        "another-project",
        "completed",
        Some("passed"),
        60,
    );
    let landed = landed_briefs(&conn, "vg-game").unwrap();
    assert_eq!(
        landed.iter().map(|l| l.title.as_str()).collect::<Vec<_>>(),
        ["Title new", "Title unchecked", "Title old"],
        "passed (or needing no gates), this project only, newest first"
    );
    assert_eq!(landed[0].goal, "Goal new");
    assert_eq!(landed[0].brief, "## Intent\nAsk new\n\n## Spec\nBuild new");
    assert_eq!(landed[0].at, 30);
    // Another project, an empty name and a project nothing landed in.
    assert_eq!(landed_briefs(&conn, "another-project").unwrap().len(), 1);
    assert!(landed_briefs(&conn, "nothing-here").unwrap().is_empty());
    assert!(landed_briefs(&conn, "").unwrap().is_empty());
    assert!(landed_briefs(&conn, "   ").unwrap().is_empty());
    // A project is matched whole, never by a prefix or a pattern.
    assert!(landed_briefs(&conn, "vg").unwrap().is_empty());
    assert!(landed_briefs(&conn, "vg%").unwrap().is_empty());
}

#[test]
fn the_landed_briefs_are_capped_in_number_and_in_length() {
    let store = SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    for n in 0..40 {
        land(
            &conn,
            &format!("t{n:02}"),
            "p",
            "completed",
            Some("passed"),
            n,
        );
    }
    conn.execute(
        "UPDATE delegations SET brief = ?1, title = ?2, goal = ?3 WHERE id = 't39'",
        rusqlite::params!["b".repeat(20_000), "t".repeat(500), "g".repeat(900)],
    )
    .unwrap();
    let landed = landed_briefs(&conn, "p").unwrap();
    assert_eq!(landed.len(), 30, "the newest thirty");
    assert_eq!(landed[0].title.chars().count(), 200);
    assert_eq!(landed[0].goal.chars().count(), 400);
    assert_eq!(landed[0].brief.chars().count(), 8_000);
    assert_eq!(landed[29].title, "Title t10");
}

#[test]
fn a_followed_brief_and_a_row_with_nothing_to_say_are_not_landed_tasks() {
    let store = SessionStore::open_in_memory().unwrap();
    let conn = store.lock_conn().unwrap();
    land(&conn, "worker", "p", "completed", Some("passed"), 1);
    land(&conn, "lead", "p", "completed", Some("passed"), 2);
    conn.execute(
        "UPDATE delegations SET follow = 'lead' WHERE id = 'lead'",
        [],
    )
    .unwrap();
    land(&conn, "empty", "p", "completed", Some("passed"), 3);
    conn.execute(
        "UPDATE delegations SET title = '  ', brief = NULL WHERE id = 'empty'",
        [],
    )
    .unwrap();
    let landed = landed_briefs(&conn, "p").unwrap();
    assert_eq!(
        landed.iter().map(|l| l.title.as_str()).collect::<Vec<_>>(),
        ["Title worker"]
    );
}

// ---- the schema --------------------------------------------------------------------------------------------------------------

#[test]
fn the_schema_is_a_list_of_three_closed_to_file_section_and_text_in_plain_words() {
    let schema = schema();
    assert_eq!(schema["type"], "array");
    assert_eq!(schema["maxItems"], 3);
    let item = &schema["items"];
    assert_eq!(item["additionalProperties"], false);
    assert_eq!(item["required"], json!(["file", "section", "text"]));
    assert_eq!(item["properties"]["section"]["maxLength"], 120);
    assert_eq!(item["properties"]["text"]["maxLength"], 4000);
    let mut keys: Vec<&String> = item["properties"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["file", "section", "text"]);
    let said = schema["description"].as_str().unwrap();
    assert!(
        said.contains("corrects something or adds detail") && said.contains("you must send it"),
        "{said}"
    );
    assert!(
        said.contains("updates that section first, in its own commit, then changes the code"),
        "{said}"
    );
    // No dash a person might see.
    assert!(!schema.to_string().contains('\u{2014}') && !schema.to_string().contains('\u{2013}'));
}

#[test]
fn the_commands_read_only_and_go_through_the_validating_context() {
    let lib = include_str!("../lib.rs");
    let listed: Vec<&str> = lib
        .lines()
        .map(str::trim)
        .filter(|line| line.contains("spec_record::"))
        .collect();
    assert_eq!(
        listed,
        vec![
            "firstmate::spec_record::firstmate_spec_context, // PT-6",
            "firstmate::spec_record::firstmate_spec_landed,  // PT-6"
        ],
        "{listed:?}"
    );
    let source = include_str!("spec_record.rs");
    let command = source.find("pub fn firstmate_spec_context").unwrap();
    assert!(
        source[command..].contains("context_for(&folder"),
        "the command goes through context_for"
    );
    for forbidden in [
        "std::fs::write",
        "remove_file",
        "remove_dir",
        "create_dir",
        "OpenOptions",
    ] {
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        assert!(
            !code.contains(forbidden),
            "spec_record.rs never writes: {forbidden}"
        );
    }
}
