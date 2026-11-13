//! PT-6: a living spec of record per project. Prompts and specs are the lasting artefact and code can be rebuilt from
//! them, so a correction the person makes goes into the spec first and into the code second.
//!
//! The spec is plain Markdown in the PROJECT's repo, one file per area under `docs/spec/` (a project that already keeps
//! `docs/specs/` or a root `SPEC.md` keeps it there: `home_of`), with `README.md` beside them as the index. A file has a
//! title, then `## <Section name>` sections: the heading is the section's stable id, the body what must be true in plain
//! words (the person's intent, the laws and the acceptance checks). An optional front-matter line `paths:` names the code
//! areas a file covers.
//!
//! A brief can carry up to three spec parts, `{file, section, text}`: the section as it must read once the task is done.
//! This module is what code does with them:
//!
//! - **validation** (`parse_deltas`): the file is one Markdown file directly under a spec folder, no `..`, no absolute
//!   path; the section is one line; the text is the section's body, at most 4,000 characters, with no `#` or `##`
//!   heading that would split it. The brief's tool call, the row and the done check all read them with this one function.
//! - **the brief's context** (`context_of`, the `firstmate_spec_context` command): the current text of each section the
//!   brief touches, read from the project's MAIN checkout and capped, and, for a brief with no spec part whose in-scope
//!   paths match a file's `paths:` line, that file's text as context only.
//! - **the done check** (`findings`, `order_caveat`, `prompt_section`): the spec file must have changed, its section in
//!   the worker's copy must hold the brief's new text (whitespace read as one space), and the verdict model is asked
//!   whether the diff agrees with the section. A spec change committed after the code, or in the same commit, is a
//!   caveat, never a failure.
//!
//! Every path is read inside the folder it is named under: a file that is a link leaving the project reads as missing.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::brief_checks::{normal_path, under};
use super::done_check::{ChangedFile, CodeFinding, FindingKind};

/// The most spec parts on one brief.
pub const DELTAS_MAX: usize = 3;
/// The longest section text, in characters.
pub const TEXT_MAX: usize = 4_000;
/// The longest section name, in characters.
pub const SECTION_MAX: usize = 120;
/// The longest area name (a file's name without `.md`), in characters.
const AREA_MAX: usize = 80;
/// How much of a section's current text a brief shows.
pub const CURRENT_MAX: usize = 4_000;
/// The most files shown as context for a brief with no spec part, and how much of each.
const RELATED_FILES_MAX: usize = 3;
const RELATED_TEXT_MAX: usize = 2_500;
/// The most files of a spec folder read to find the ones whose `paths:` match.
const SCAN_FILES_MAX: usize = 60;
/// The most in-scope paths read.
const SCOPE_MAX: usize = 50;
/// A spec file larger than this is not read.
const FILE_READ_MAX: u64 = 512 * 1024;
/// How much of each side of a section the verdict model reads.
const PROMPT_TEXT_MAX: usize = 1_500;

/// The folders a spec lives in: the default, then the one a project may already keep.
pub const FOLDERS: [&str; 2] = ["docs/spec", "docs/specs"];
/// A project's single spec file, when it keeps one instead of a folder.
pub const SINGLE_FILE: &str = "SPEC.md";
/// The index beside the area files.
pub const INDEX: &str = "README.md";

// ---- one spec part --------------------------------------------------------------------------------------------------

/// A section of a spec file as it must read after the task: the file, the section's name and its body.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpecDelta {
    pub file: String,
    pub section: String,
    pub text: String,
}

/// Words of `text` joined by single spaces, whatever whitespace and line endings it was written with.
pub fn norm_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A section's name as a key: whitespace collapsed, case ignored. Headings are ids, but `Login flow` and `login  flow`
/// are the same id to a person.
fn section_key(name: &str) -> String {
    norm_ws(name).to_lowercase()
}

fn same_path(a: &str, b: &str) -> bool {
    a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

/// A Windows device name is no file name there, whatever its extension.
fn reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let numbered = stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9');
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered
}

/// Why an area name (a spec file's name without `.md`) can't be used, in plain words.
fn area_problem(stem: &str) -> Option<String> {
    if stem.is_empty() {
        return Some("the file needs a name before .md.".into());
    }
    if stem.chars().count() > AREA_MAX {
        return Some(format!(
            "the file's name is longer than {AREA_MAX} characters."
        ));
    }
    if stem.chars().any(char::is_whitespace) {
        return Some("a file's name has no spaces: use hyphens, like login-flow.md.".into());
    }
    if stem
        .chars()
        .any(|c| c.is_control() || "<>:\"|?*\\/".contains(c))
    {
        return Some("a file's name has a character that isn't allowed in a file name.".into());
    }
    if stem.starts_with('.') || stem.ends_with('.') {
        return Some("a file's name can't start or end with a dot.".into());
    }
    if reserved(stem) {
        return Some("that name is reserved on Windows.".into());
    }
    None
}

/// A spec file a brief names, validated: Markdown, directly under a spec folder (or the root `SPEC.md`), inside the
/// project. `..`, an absolute path, a drive and a control character are refused, as they are for `scope` and `leave`.
pub fn spec_file(raw: &str) -> Result<String, String> {
    let path = normal_path(raw)?;
    if path == SINGLE_FILE {
        return Ok(path);
    }
    for folder in FOLDERS {
        let Some(rest) = path
            .strip_prefix(folder)
            .and_then(|rest| rest.strip_prefix('/'))
        else {
            continue;
        };
        if rest.contains('/') {
            return Err(format!(
                "\"{path}\" is in a sub-folder. A spec file sits directly in {folder}/, one file per area: {folder}/<area>.md."
            ));
        }
        let Some(stem) = rest.strip_suffix(".md") else {
            return Err(format!(
                "\"{path}\" isn't a Markdown file. Name it {folder}/<area>.md."
            ));
        };
        if stem.eq_ignore_ascii_case("README") {
            return Err(format!(
                "{folder}/README.md is the index, and the worker keeps it. Name an area file, like {folder}/<area>.md."
            ));
        }
        if let Some(why) = area_problem(stem) {
            return Err(format!("\"{path}\": {why}"));
        }
        return Ok(path);
    }
    Err(format!(
        "\"{path}\" isn't a spec file. A spec file is docs/spec/<area>.md (or the project's own: docs/specs/<area>.md, or SPEC.md)."
    ))
}

fn section_name(raw: &str) -> Result<String, String> {
    if raw.contains(['\n', '\r']) {
        return Err("a spec part's section is one line: the name of one `##` heading.".into());
    }
    let name = norm_ws(raw);
    if name.is_empty() {
        return Err("a spec part needs the section's name (section).".into());
    }
    if name.starts_with('#') {
        return Err("give the section's name without the `#` marks.".into());
    }
    if name.chars().count() > SECTION_MAX {
        return Err(format!(
            "the section's name is longer than {SECTION_MAX} characters."
        ));
    }
    Ok(name)
}

/// The text of a part: the section's body, line endings read as one, its own heading taken off the top when it was
/// sent with it. A `#` or `##` heading inside would split the section, so it is refused.
fn section_text(raw: &str, section: &str) -> Result<String, String> {
    if raw.contains('\0') {
        return Err("a spec part's text has a null character.".into());
    }
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    let text = unified.trim();
    if text.is_empty() {
        return Err("a spec part needs the section as it must read (text).".into());
    }
    if text.chars().count() > TEXT_MAX {
        return Err(format!(
            "a spec part's text is longer than {TEXT_MAX} characters. Keep the section short, or split the area into two sections."
        ));
    }
    let mut lines: Vec<&str> = text.lines().collect();
    if let Some((2, title)) = lines.first().and_then(|line| heading(line)) {
        if section_key(&title) == section_key(section) {
            lines.remove(0);
        }
    }
    let body = lines.join("\n").trim().to_string();
    if body.is_empty() {
        return Err("a spec part needs the section as it must read (text).".into());
    }
    let doc = Doc::of_body(&body);
    if doc
        .body
        .iter()
        .any(|(line, fenced)| !fenced && matches!(heading(line), Some((level, _)) if level <= 2))
    {
        return Err(
            "a spec part's text is the section's body: it has no `#` or `##` heading (use `###` for a part of it).".into(),
        );
    }
    Ok(body)
}

/// The spec parts of a tool call, validated: at most 3, each `{file, section, text}` and nothing else, no section twice.
pub fn parse_deltas(value: &Value) -> Result<Vec<SpecDelta>, String> {
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("spec must be a list of {file, section, text}.".into()),
    };
    if items.len() > DELTAS_MAX {
        return Err(format!(
            "Give at most {DELTAS_MAX} spec parts on one brief; send the rest with the next task."
        ));
    }
    let mut out: Vec<SpecDelta> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let number = index + 1;
        let part = |why: String| format!("Spec part {number}: {why}");
        let Some(object) = item.as_object() else {
            return Err(part("it must be {file, section, text}.".into()));
        };
        if let Some(extra) = object
            .keys()
            .find(|key| !matches!(key.as_str(), "file" | "section" | "text"))
        {
            return Err(part(format!(
                "it has file, section and text only; \"{extra}\" isn't one."
            )));
        }
        let get = |key: &str| -> Result<&str, String> {
            object
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| part(format!("{key} must be text.")))
        };
        let file = spec_file(get("file")?).map_err(part)?;
        let section = section_name(get("section")?).map_err(part)?;
        let text = section_text(get("text")?, &section).map_err(part)?;
        if out.iter().any(|have| {
            same_path(&have.file, &file) && section_key(&have.section) == section_key(&section)
        }) {
            return Err(part(format!(
                "\"{section}\" of {file} is named twice. Send each section once."
            )));
        }
        out.push(SpecDelta {
            file,
            section,
            text,
        });
    }
    Ok(out)
}

/// What a tool call's `spec` must satisfy before it reaches the app. `spec` is optional.
pub fn refuse_bad_spec(spec: Option<&Value>) -> Result<(), String> {
    parse_deltas(spec.unwrap_or(&Value::Null)).map(|_| ())
}

/// The `spec` property of delegate_task, and of each part of delegate_tasks: up to three sections of the project's spec of
/// record, each as it must read once the job is done. The first mate must send one when the person's ask is a correction or
/// new detail: the worker updates the spec first, then the code.
pub fn schema() -> Value {
    serde_json::json!({
        "type": "array",
        "maxItems": DELTAS_MAX,
        "items": {
            "type": "object",
            "properties": {
                "file": { "type": "string", "maxLength": 400, "description": "The spec file, directly under the project's spec folder: docs/spec/<area>.md (docs/specs/<area>.md or SPEC.md when the project already keeps its spec there). It is created when it doesn't exist yet." },
                "section": { "type": "string", "maxLength": SECTION_MAX, "description": "The section's name: one ## heading of that file. It is the section's stable id." },
                "text": { "type": "string", "maxLength": TEXT_MAX, "description": "The section as it must read once this job is done: its body in plain words (the person's intent, the laws, the acceptance checks as lines like a check line), with no # or ## heading." }
            },
            "required": ["file", "section", "text"],
            "additionalProperties": false
        },
        "description": "The project's spec of record that this job changes. When the person's ask corrects something or adds detail (add detail, change this), you must send it: up to 3 parts, each one section of a spec file as it must read after the job. The worker updates that section first, in its own commit, then changes the code to match it; the app checks that the file changed and the section holds your text. Leave out for a job that changes no behaviour."
    })
}

// ---- the landed briefs spec_start reads -----------------------------------------------------------------------------------

/// The most landed tasks a spec draft reads, and how much of each brief is handed over (the webview cuts it further).
const LANDED_MAX: usize = 30;
const LANDED_BRIEF_MAX: usize = 8_000;
/// How many of a project's newest rows are looked at to find the landed ones.
const LANDED_SCAN: i64 = 300;

/// One task that landed in a project: its title, its definition of done and its brief as the worker was given it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Landed {
    pub title: String,
    pub goal: String,
    pub brief: String,
    pub at: i64,
}

/// The project's landed tasks, newest first: workers' rows that finished and whose gates passed or that their first mate accepted
/// (`status::is_done`). A row of another project, a running one and a failed one are not landed. Reads only.
pub fn landed_briefs(conn: &rusqlite::Connection, project: &str) -> Result<Vec<Landed>, String> {
    let project = project.trim();
    if project.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = conn
        .prepare(
            "SELECT title, goal, brief, state, gate_verdict, COALESCE(settled_at, updated_at)
             FROM delegations
             WHERE project = ?1 AND follow IS NULL AND state = 'completed'
             ORDER BY COALESCE(settled_at, updated_at) DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![project, LANDED_SCAN], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (title, goal, brief, state, verdict, at) = row.map_err(|e| e.to_string())?;
        if !super::status::is_done(&state, verdict.as_deref()) {
            continue;
        }
        let brief = brief.unwrap_or_default();
        if title.as_deref().unwrap_or("").trim().is_empty() && brief.trim().is_empty() {
            continue;
        }
        out.push(Landed {
            title: cap(title.as_deref().unwrap_or("").trim(), 200).0,
            goal: cap(goal.as_deref().unwrap_or("").trim(), 400).0,
            brief: cap(brief.trim(), LANDED_BRIEF_MAX).0,
            at,
        });
        if out.len() >= LANDED_MAX {
            break;
        }
    }
    Ok(out)
}

/// The project's landed tasks, for the worker `spec_start` hands the draft to. Reads only.
#[tauri::command(async)]
pub fn firstmate_spec_landed(
    store: tauri::State<'_, crate::session_store::SessionStore>,
    project: String,
) -> Result<Vec<Landed>, String> {
    landed_briefs(&*store.lock_conn()?, &project)
}

// ---- reading Markdown -----------------------------------------------------------------------------------------------

/// Whether `line` opens or closes a fenced code block, and with which mark.
fn fence_mark(line: &str) -> Option<char> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let mark = trimmed.chars().next()?;
    if mark != '`' && mark != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|c| *c == mark).count();
    if run < 3 {
        return None;
    }
    // "```code```" on one line is inline code, not a fence.
    if mark == '`' && trimmed[run..].contains('`') {
        return None;
    }
    Some(mark)
}

/// An ATX heading's level (1 to 6) and title, closing `#`s taken off; none for any other line.
fn heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let title = rest.trim();
    let bare = title.trim_end_matches('#');
    let title = if bare.len() < title.len() && (bare.is_empty() || bare.ends_with([' ', '\t'])) {
        bare.trim_end()
    } else {
        title
    };
    Some((level, title.to_string()))
}

/// A Markdown file read for its headings: the front matter apart, and each other line with whether it sits in a fenced
/// code block (a `## ` inside one is code, not a heading).
struct Doc<'a> {
    front: Vec<&'a str>,
    body: Vec<(&'a str, bool)>,
}

/// Each line with whether it sits in a fenced code block.
fn fenced(lines: Vec<&str>) -> Vec<(&str, bool)> {
    let mut open: Option<char> = None;
    lines
        .into_iter()
        .map(|line| {
            let mark = fence_mark(line);
            match (open, mark) {
                (None, Some(mark)) => {
                    open = Some(mark);
                    (line, true)
                }
                (Some(opened), Some(mark)) if opened == mark => {
                    open = None;
                    (line, true)
                }
                (Some(_), _) => (line, true),
                (None, None) => (line, false),
            }
        })
        .collect()
}

impl<'a> Doc<'a> {
    /// A whole file: its front matter (a `---` block at the very top) apart from the body.
    fn of(text: &'a str) -> Doc<'a> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let mut lines: Vec<&str> = text.lines().collect();
        let mut front = Vec::new();
        if lines.first().is_some_and(|line| line.trim_end() == "---") {
            if let Some(end) = lines
                .iter()
                .skip(1)
                .position(|line| matches!(line.trim_end(), "---" | "..."))
            {
                front = lines[1..=end].to_vec();
                lines.drain(..=end + 1);
            }
        }
        Doc {
            front,
            body: fenced(lines),
        }
    }

    /// A section's body: no front matter, so a `---` at its top is only a rule.
    fn of_body(text: &'a str) -> Doc<'a> {
        Doc {
            front: Vec::new(),
            body: fenced(text.lines().collect()),
        }
    }
}

/// The body of the first `##` section named `name` (whitespace and case ignored): everything up to the next `#` or `##`
/// heading outside a code block, `###` parts and all.
pub fn find_section(text: &str, name: &str) -> Option<String> {
    let wanted = section_key(name);
    let doc = Doc::of(text);
    let mut collecting = false;
    let mut found = false;
    let mut body: Vec<&str> = Vec::new();
    for (line, fenced) in &doc.body {
        if !fenced {
            if let Some((level, title)) = heading(line) {
                if level <= 2 {
                    if collecting {
                        break;
                    }
                    if level == 2 && section_key(&title) == wanted {
                        collecting = true;
                        found = true;
                    }
                    continue;
                }
            }
        }
        if collecting {
            body.push(line);
        }
    }
    found.then(|| body.join("\n").trim().to_string())
}

/// Whether `section` holds `wanted`, whitespace read as one space.
pub fn holds(section: &str, wanted: &str) -> bool {
    norm_ws(section).contains(&norm_ws(wanted))
}

/// The code areas a file's front matter lists on its `paths:` line: `paths: a, b`, `paths: [a, b]` or a block list.
/// A path that isn't inside the project is dropped.
pub fn paths_of(text: &str) -> Vec<String> {
    let doc = Doc::of(text);
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let raw = raw.trim().trim_matches(['"', '\'']).trim();
        if let Ok(path) = normal_path(raw) {
            if !out.contains(&path) && out.len() < SCOPE_MAX {
                out.push(path);
            }
        }
    };
    let mut at = 0;
    while at < doc.front.len() {
        let line = doc.front[at];
        at += 1;
        let Some(rest) = line.strip_prefix("paths:") else {
            continue;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            while at < doc.front.len() {
                let Some(item) = doc.front[at].trim_start().strip_prefix("- ") else {
                    break;
                };
                push(item);
                at += 1;
            }
        } else {
            let list = rest
                .strip_prefix('[')
                .map_or(rest, |inner| inner.strip_suffix(']').unwrap_or(inner));
            list.split(',').for_each(&mut push);
        }
    }
    out
}

/// Whether any of a file's declared paths covers any in-scope path, or the other way round.
fn covers(declared: &[String], scope: &[String]) -> bool {
    declared
        .iter()
        .any(|d| scope.iter().any(|s| under(d, s) || under(s, d)))
}

fn cap(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    (
        text.chars()
            .take(max)
            .collect::<String>()
            .trim_end()
            .to_string(),
        true,
    )
}

fn indented(text: &str) -> String {
    text.lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- reading a spec file ----------------------------------------------------------------------------------------------

/// What reading one file inside a folder gave.
#[derive(Debug, PartialEq, Eq)]
enum Read {
    Missing,
    /// It is there but is no plain text file inside the folder: a link out of it, a folder, too large, not text.
    Unusable(String),
    Text(String),
}

fn read_inside(root: &Path, rel: &str) -> Read {
    let full = root.join(rel);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Missing,
        Err(e) => return Read::Unusable(e.to_string()),
    };
    let (Ok(real_root), Ok(real)) = (crate::fs::canonical(root), crate::fs::canonical(&full))
    else {
        return if meta.file_type().is_symlink() {
            Read::Missing
        } else {
            Read::Unusable("it can't be resolved".into())
        };
    };
    if !real.starts_with(&real_root) {
        return Read::Unusable("it is a link that leaves the project".into());
    }
    if !real.is_file() {
        return Read::Unusable("it isn't a file".into());
    }
    let mut bytes = Vec::new();
    let read = std::fs::File::open(&real)
        .and_then(|file| file.take(FILE_READ_MAX + 1).read_to_end(&mut bytes));
    if let Err(e) = read {
        return Read::Unusable(e.to_string());
    }
    if bytes.len() as u64 > FILE_READ_MAX {
        return Read::Unusable("it is too large to read".into());
    }
    if bytes.contains(&0) {
        return Read::Unusable("it isn't text".into());
    }
    Read::Text(String::from_utf8_lossy(&bytes).into_owned())
}

// ---- where a project keeps its spec --------------------------------------------------------------------------------------

/// Where a project's spec lives: `docs/spec/` unless the project already keeps `docs/specs/`, or only a root `SPEC.md`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpecHome {
    /// The folder (`docs/spec`), or the one file (`SPEC.md`) when the project keeps a single file.
    pub folder: String,
    pub single_file: bool,
    /// Whether the folder or file is already there. False: the first spec part creates it, at `docs/spec/` by default.
    pub exists: bool,
    /// Whether the folder has its `README.md` index.
    pub index: bool,
}

pub fn home_of(root: &Path) -> SpecHome {
    for folder in FOLDERS {
        if root.join(folder).is_dir() {
            return SpecHome {
                folder: folder.into(),
                single_file: false,
                exists: true,
                index: matches!(
                    read_inside(root, &format!("{folder}/{INDEX}")),
                    Read::Text(_)
                ),
            };
        }
    }
    if root.join(SINGLE_FILE).is_file() {
        return SpecHome {
            folder: SINGLE_FILE.into(),
            single_file: true,
            exists: true,
            index: false,
        };
    }
    SpecHome {
        folder: FOLDERS[0].into(),
        single_file: false,
        exists: false,
        index: false,
    }
}

/// Why these spec parts don't belong where this project keeps its spec, in words the first mate can act on; none when they do.
pub fn home_refusal(home: &SpecHome, deltas: &[SpecDelta]) -> Option<String> {
    let folder_of = |file: &str| -> String {
        if file == SINGLE_FILE {
            SINGLE_FILE.into()
        } else {
            file.rsplit_once('/')
                .map_or(String::new(), |(dir, _)| dir.into())
        }
    };
    let first = deltas.first()?;
    if home.exists {
        let wrong = deltas.iter().find(|d| folder_of(&d.file) != home.folder)?;
        return Some(if home.single_file {
            format!(
                "This project keeps its spec in {SINGLE_FILE}, so \"{}\" belongs there: use file \"{SINGLE_FILE}\" with a section of it.",
                wrong.file
            )
        } else {
            format!(
                "This project keeps its spec in {0}/, so \"{1}\" belongs there: use {0}/<area>.md.",
                home.folder, wrong.file
            )
        });
    }
    // A project with no spec yet: any recognised place, but one place for the whole brief.
    let place = folder_of(&first.file);
    deltas.iter().any(|d| folder_of(&d.file) != place).then(|| {
        "Keep every spec part of one brief in one place: one folder, or SPEC.md.".to_string()
    })
}

// ---- the brief's context -------------------------------------------------------------------------------------------------

/// The current text of one section a brief touches, as the project's main checkout has it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub file: String,
    pub section: String,
    /// Whether the file is there at all (false: the brief creates it).
    pub file_found: bool,
    pub found: bool,
    pub text: String,
    pub cut: bool,
}

/// A spec file whose `paths:` cover a brief with no spec part: its text, as context only.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    pub file: String,
    pub text: String,
    pub cut: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub home: SpecHome,
    /// Set when the spec parts name a place the project doesn't keep its spec.
    pub refusal: Option<String>,
    pub current: Vec<Current>,
    pub related: Vec<Related>,
}

/// The spec files a project's context can come from, in the order they are read.
fn candidates(root: &Path, home: &SpecHome) -> Vec<String> {
    if home.single_file {
        return vec![SINGLE_FILE.into()];
    }
    let Ok(entries) = std::fs::read_dir(root.join(&home.folder)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| name.ends_with(".md") && !name.eq_ignore_ascii_case(INDEX))
        .collect();
    names.sort();
    names.truncate(SCAN_FILES_MAX);
    names
        .into_iter()
        .map(|name| format!("{}/{name}", home.folder))
        .collect()
}

fn related_of(root: &Path, home: &SpecHome, scope: &[String]) -> Vec<Related> {
    let mut out = Vec::new();
    for file in candidates(root, home) {
        if out.len() >= RELATED_FILES_MAX {
            break;
        }
        let Read::Text(text) = read_inside(root, &file) else {
            continue;
        };
        if !covers(&paths_of(&text), scope) {
            continue;
        }
        let body = Doc::of(&text)
            .body
            .iter()
            .map(|(line, _)| *line)
            .collect::<Vec<_>>()
            .join("\n");
        let (text, cut) = cap(body.trim(), RELATED_TEXT_MAX);
        out.push(Related { file, text, cut });
    }
    out
}

/// What a brief reads of the spec, from the project's main checkout at the time it is written.
pub fn context_of(root: &Path, deltas: &[SpecDelta], scope: &[String]) -> Context {
    let home = home_of(root);
    let refusal = home_refusal(&home, deltas);
    let current = deltas
        .iter()
        .map(|delta| {
            let mut now = Current {
                file: delta.file.clone(),
                section: delta.section.clone(),
                file_found: false,
                found: false,
                text: String::new(),
                cut: false,
            };
            if let Read::Text(text) = read_inside(root, &delta.file) {
                now.file_found = true;
                if let Some(body) = find_section(&text, &delta.section) {
                    now.found = true;
                    (now.text, now.cut) = cap(&body, CURRENT_MAX);
                }
            }
            now
        })
        .collect();
    // No spec part: the files whose `paths:` cover the in-scope paths are context, and only context.
    let related = if deltas.is_empty() && !scope.is_empty() && home.exists {
        related_of(root, &home, scope)
    } else {
        Vec::new()
    };
    Context {
        home,
        refusal,
        current,
        related,
    }
}

/// What the webview asks: the spec parts it validated (read again here) and the in-scope paths of the brief.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInput {
    #[serde(default)]
    pub deltas: Value,
    #[serde(default)]
    pub scope: Vec<String>,
}

/// The project's main checkout for `folder`: a worker's copy has its own spec files, and the brief shows the project's.
fn root_of(folder: &str) -> Result<PathBuf, String> {
    let cwd = crate::fs::expand_home(folder);
    if crate::chat_folder::is_blank(&cwd) {
        return Err(crate::chat_folder::NEEDS_FOLDER.into());
    }
    Ok(crate::project_file::main_checkout(&cwd).unwrap_or(cwd))
}

pub fn context_for(folder: &str, input: &ContextInput) -> Result<Context, String> {
    let root = root_of(folder)?;
    let deltas = parse_deltas(&input.deltas)?;
    let scope: Vec<String> = input
        .scope
        .iter()
        .filter_map(|path| normal_path(path).ok())
        .take(SCOPE_MAX)
        .collect();
    Ok(context_of(&root, &deltas, &scope))
}

/// The spec parts' current sections and the context files, read from the project's main checkout. Reads only.
#[tauri::command(async)]
pub fn firstmate_spec_context(folder: String, input: ContextInput) -> Result<Context, String> {
    context_for(&folder, &input)
}

// ---- the done check ---------------------------------------------------------------------------------------------------

fn finding(file: &str, detail: String) -> CodeFinding {
    CodeFinding {
        kind: FindingKind::SpecNotUpdated,
        file: Some(file.to_string()),
        detail,
    }
}

/// Code-only findings of the spec rule, for a brief with spec parts: each spec file must have changed in the worker's
/// copy, and its section there must hold the brief's new text (whitespace read as one space). `checkout` is the worker's
/// copy, `files` what it changed.
pub fn findings(deltas: &[SpecDelta], checkout: &Path, files: &[ChangedFile]) -> Vec<CodeFinding> {
    let mut out = Vec::new();
    for delta in deltas {
        let (file, section) = (delta.file.as_str(), delta.section.as_str());
        let changed = files.iter().find(|changed| same_path(&changed.path, file));
        // Listed by git but with the same text on both sides (a mode change): not a change to the spec. An empty text on both
        // sides is a file too large to read, which says nothing, so it is not taken for "unchanged".
        let unchanged = match changed {
            None => true,
            Some(changed) => {
                changed.before == changed.after
                    && changed
                        .before
                        .as_deref()
                        .is_some_and(|text| !text.is_empty())
            }
        };
        if unchanged {
            out.push(finding(
                file,
                format!("{file} was not changed, and the brief asked for its \"{section}\" section to be updated first."),
            ));
            continue;
        }
        match read_inside(checkout, file) {
            Read::Missing => out.push(finding(
                file,
                format!("{file} isn't in the worker's copy, so its \"{section}\" section can't read as the brief asked."),
            )),
            Read::Unusable(why) => out.push(finding(
                file,
                format!("{file} can't be read as a plain file inside the copy ({why})."),
            )),
            Read::Text(text) => match find_section(&text, section) {
                None => out.push(finding(
                    file,
                    format!("{file} has no \"{section}\" section; the brief asked for it."),
                )),
                Some(body) if !holds(&body, &delta.text) => out.push(finding(
                    file,
                    format!("The \"{section}\" section of {file} doesn't contain the text the brief asked for."),
                )),
                Some(_) => {}
            },
        }
    }
    out
}

/// The files each commit of the worker's copy changed since `base`, oldest first. A copy git can't read gives none.
pub fn commits_since(dir: &Path, base: Option<&str>) -> Vec<Vec<String>> {
    let Some(base) = base else {
        return Vec::new();
    };
    let range = format!("{base}..HEAD");
    let Ok((true, out, _)) = super::gates::git(
        dir,
        &[
            "log",
            "--reverse",
            "--no-renames",
            "--name-only",
            "--format=%x01%H",
            &range,
            "--",
        ],
    ) else {
        return Vec::new();
    };
    parse_log(&String::from_utf8_lossy(&out))
}

/// `git log --name-only --format=%x01%H` read as one list of files per commit.
pub fn parse_log(log: &str) -> Vec<Vec<String>> {
    log.split('\u{1}')
        .skip(1)
        .map(|chunk| {
            chunk
                .lines()
                .skip(1)
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .collect()
}

fn is_spec_path(path: &str) -> bool {
    let path = path.replace('\\', "/").to_lowercase();
    path == SINGLE_FILE.to_lowercase()
        || FOLDERS
            .iter()
            .any(|folder| path.starts_with(&format!("{folder}/")))
}

/// The caveat when the spec was not committed first: after the code, or in a commit that also holds code. Never a
/// failure. None when the order is right, when the spec has no commit yet (the committed gate says so), or when no code
/// was committed.
pub fn order_caveat(deltas: &[SpecDelta], commits: &[Vec<String>]) -> Option<String> {
    let spec = commits.iter().position(|files| {
        files
            .iter()
            .any(|f| deltas.iter().any(|d| same_path(&d.file, f)))
    })?;
    let code = commits
        .iter()
        .position(|files| files.iter().any(|f| !is_spec_path(f)))?;
    match spec.cmp(&code) {
        std::cmp::Ordering::Less => None,
        std::cmp::Ordering::Equal => Some(
            "The spec change shares a commit with code. The brief asked for it first, in its own commit.".into(),
        ),
        std::cmp::Ordering::Greater => Some(
            "The spec was changed after the code. The brief asked for the spec first, in its own commit, then the code.".into(),
        ),
    }
}

/// What the verdict model reads of the spec: each section the brief asked for, as it must read and as the worker's copy
/// reads now, and the one more claim row to add. None for a brief with no spec part.
pub fn prompt_section(deltas: &[SpecDelta], checkout: &Path) -> Option<String> {
    if deltas.is_empty() {
        return None;
    }
    let mut out = String::from(
        "## Spec of record\nThe brief asked for these spec sections to read as below once the task is done. Add one claim row for each: \"The diff agrees with <file>, <section>\". Say verified when the diff makes what the section says true, refuted when the diff contradicts the section or leaves what it says undone, and unverifiable when the diff can't show it.",
    );
    for delta in deltas {
        let now = match read_inside(checkout, &delta.file) {
            Read::Text(text) => find_section(&text, &delta.section)
                .map(|body| cap(&body, PROMPT_TEXT_MAX).0)
                .unwrap_or_else(|| "(the worker's copy has no such section)".into()),
            _ => "(the worker's copy has no such file)".into(),
        };
        let (wanted, _) = cap(&delta.text, PROMPT_TEXT_MAX);
        out.push_str(&format!(
            "\n\n### {}, {}\nThe brief asked it to read:\n{}\nThe worker's copy reads now:\n{}",
            delta.file,
            delta.section,
            indented(&wanted),
            indented(&now),
        ));
    }
    Some(out)
}

#[cfg(test)]
#[path = "spec_record_tests.rs"]
mod tests;
