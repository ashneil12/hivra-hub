//! WP-104: the same shell judgement as `src/features/autopilot/model/safeApproval.ts` (`safeCommand`).
//!
//! A check timer may run a command only when that function would allow it. This is a line-by-line port of the shell
//! half, not a second list: the names, the flags and the refusals stay the ones already written there. Do not add a
//! command here. The path rules are the ones credentialPaths.ts applies to a timer (no chat folder known, so a dot-named
//! part, a climb or a rooted word is outside it). The parity test (`parity` below) runs the same commands through both
//! sides from src/shared/security/approvalParity.json.

use std::sync::OnceLock;

use regex::Regex;

const SHELL_META: &[char] = &[';', '&', '|', '`', '$', '<', '>', '(', ')', '\n', '\r'];

fn is_plain(c: char) -> bool {
    matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '-' | '.' | '/' | ':' | '=' | ',' | '@' | '%' | '+' | '~')
}

/// The words sh would pass. None when a quote is open or an unquoted character could expand.
pub fn shell_words(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.chars().collect();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            let end = chars[i + 1..].iter().position(|ch| *ch == '\'')?;
            let end = i + 1 + end;
            word.extend(chars[i + 1..end].iter());
            in_word = true;
            i = end;
        } else if c == '"' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '"' {
                if chars[j] == '\\'
                    && j + 1 < chars.len()
                    && (chars[j + 1] == '"' || chars[j + 1] == '\\')
                {
                    j += 1;
                }
                word.push(chars[j]);
                j += 1;
            }
            if j >= chars.len() {
                return None;
            }
            in_word = true;
            i = j;
        } else if c == '\\' {
            if i + 1 >= chars.len() {
                return None;
            }
            i += 1;
            word.push(chars[i]);
            in_word = true;
        } else if c == ' ' || c == '\t' {
            if in_word {
                words.push(std::mem::take(&mut word));
            }
            in_word = false;
        } else if is_plain(c) {
            word.push(c);
            in_word = true;
        } else {
            return None;
        }
        i += 1;
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

fn has(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|arg| {
        flags
            .iter()
            .any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")))
    })
}

fn branch_flags() -> &'static Regex {
    static FLAGS: OnceLock<Regex> = OnceLock::new();
    FLAGS.get_or_init(|| {
        Regex::new(
            r"^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort(=.*)?|--format(=.*)?|--column|--no-column|--color(=.*)?|--no-color|--abbrev(=.*)?|--no-abbrev|-i|--ignore-case|--omit-empty)$",
        )
        .expect("branch flags")
    })
}

fn git_read(args: &[String]) -> Option<&'static str> {
    let Some(sub) = args.first() else {
        return Some("only git status, diff, log, show and branch run by themselves");
    };
    if !matches!(sub.as_str(), "status" | "diff" | "log" | "show" | "branch") {
        return Some("only git status, diff, log, show and branch run by themselves");
    }
    let rest = &args[1..];
    // Round 4, item 4: --textconv runs an outside program on every file, as --ext-diff does.
    if has(rest, &["--output", "--ext-diff", "--textconv"]) {
        return Some("it writes a file or runs an outside diff");
    }
    if sub == "branch" {
        let flags: Vec<&str> = rest
            .iter()
            .filter(|arg| arg.starts_with('-'))
            .map(String::as_str)
            .collect();
        if flags.iter().any(|flag| !branch_flags().is_match(flag)) {
            return Some("git branch only lists by itself");
        }
        let query = [
            "-l",
            "--list",
            "--merged",
            "--no-merged",
            "--contains",
            "--no-contains",
            "--points-at",
        ];
        if rest.iter().any(|arg| !arg.starts_with('-'))
            && !flags.iter().any(|flag| query.contains(flag))
        {
            return Some("git branch only lists by itself");
        }
    }
    None
}

// Round 2 (C1, in step with safeApproval.ts): tests and builds run code the chat may have just written, so only
// cargo fmt --check runs by itself.
fn cargo_read(args: &[String]) -> Option<&'static str> {
    let Some(sub) = args.first() else {
        return Some("only cargo fmt --check runs by itself; cargo test, check, clippy and build run code, so they wait for Ash");
    };
    if sub.as_str() != "fmt" {
        return Some("only cargo fmt --check runs by itself; cargo test, check, clippy and build run code, so they wait for Ash");
    }
    let rest = &args[1..];
    if sub == "fmt" && !rest.iter().any(|arg| arg == "--check") {
        return Some("cargo fmt rewrites files unless it is --check");
    }
    if has(
        rest,
        &[
            "--config",
            "--manifest-path",
            "--target-dir",
            "--artifact-dir",
            "--out-dir",
            "--fix",
            "--allow-dirty",
            "--allow-staged",
            "--emit",
        ],
    ) || rest.iter().any(|arg| arg.starts_with("-Z"))
    {
        return Some("that cargo option doesn't run by itself");
    }
    None
}

const HELD: &str = "it names a login store, a folder outside the chat's own, or files the ignore rules hide, so it waits for Ash";
const UNREADABLE_LIST: &str = "the shared list of agent configs can't be read, so it waits for Ash";

/// The shared list of agent and tool configs (src/shared/security/agentConfigPaths.json), compiled in from the same file
/// the TypeScript approval check imports, so the two lists cannot drift (review round 3, item 1).
const PROTECTED_JSON: &str = include_str!("../../../src/shared/security/agentConfigPaths.json");

/// The names a timer reads by. `pathSequences` (the guard's own source) is an edit's rule only, and a timer never edits, so
/// it is not read here (src/features/autopilot/model/protectedConfig.ts holds it for an edit).
struct ProtectedList {
    files: Vec<String>,
    dirs: Vec<String>,
    suffixes: Vec<Vec<String>>,
}

/// The list read fail-closed (round 4, item 9): a malformed file is None, and then every read holds. Nothing here may
/// panic, since a panic inside a check poisons the store's lock until the app restarts.
fn parse_protected(json: &str) -> Option<ProtectedList> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let names = |key: &str| -> Option<Vec<String>> {
        value
            .get(key)?
            .as_array()?
            .iter()
            .map(|name| name.as_str().map(fold_segment))
            .collect()
    };
    let runs = |key: &str| -> Option<Vec<Vec<String>>> {
        value
            .get(key)?
            .as_array()?
            .iter()
            .map(|run| {
                run.as_str()
                    .map(|text| text.split('/').map(fold_segment).collect())
            })
            .collect()
    };
    Some(ProtectedList {
        files: names("files")?,
        dirs: names("dirs")?,
        suffixes: runs("pathSuffixes")?,
    })
}

fn protected_list() -> Option<&'static ProtectedList> {
    static LIST: OnceLock<Option<ProtectedList>> = OnceLock::new();
    LIST.get_or_init(|| parse_protected(PROTECTED_JSON))
        .as_ref()
}

/// A segment folded as the TypeScript side folds it, for the ASCII names this side reads: lower case, trailing dots and
/// spaces dropped (`.codex.` is `.codex`).
fn fold_segment(part: &str) -> String {
    part.to_ascii_lowercase()
        .trim_end_matches([' ', '.'])
        .to_string()
}

/// Whether the segments of a path name a protected config: a folder in the list, a file in the list, or a listed suffix.
/// The dot rule is not here: the timer's dot rule is the dot check in `names_login_or_outside`.
fn protected_config(list: &ProtectedList, folded: &[String]) -> bool {
    let Some(last) = folded.last() else {
        return false;
    };
    if folded.iter().any(|part| list.dirs.contains(part)) || list.files.contains(last) {
        return true;
    }
    list.suffixes.iter().any(|suffix| {
        folded.len() >= suffix.len() && folded[folded.len() - suffix.len()..] == suffix[..]
    })
}

/// A brace list with a slash or a climb inside it (`{/etc,src}`, `{../..,src}`), which a shell expands before the command
/// runs (round 3, item 5).
fn braces_outside(word: &str) -> bool {
    let mut rest = word;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            return false;
        };
        let inner = &after[..close];
        if inner.contains('/') || inner.contains("..") {
            return true;
        }
        rest = &after[close + 1..];
    }
    false
}

fn is_drive_path(word: &str) -> bool {
    let bytes = word.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// A Windows 8.3 short name in one segment (`ENV~1`, `CLAUDE~1.MD`), which hides the real name from a plain check (round 4,
/// item 5). The same pattern as safeApproval's TypeScript side.
fn short_name_segment(part: &str) -> bool {
    static SHORT: OnceLock<Regex> = OnceLock::new();
    SHORT
        .get_or_init(|| {
            Regex::new(r"^[^~/\\]{1,8}~\d+(\.[^.]{1,3})?$").expect("short name pattern")
        })
        .is_match(part)
}

// The names, places and extensions credentialPaths.ts holds, in the same words (round 4: a parity test holds the two
// sides together, src/shared/security/approvalParity.json).
const CREDENTIAL_PREFIXES: &[&str] = &[
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "service-account",
    "terraform.tfstate",
    "kubeconfig",
];
const CREDENTIAL_NAMES: &[&str] = &[
    ".netrc",
    "_netrc",
    ".pgpass",
    ".my.cnf",
    ".npmrc",
    ".pypirc",
    ".dockercfg",
    ".git-credentials",
    ".s3cfg",
    ".boto",
    ".htpasswd",
    ".envrc",
    ".claude.json",
    ".gitconfig",
    ".terraformrc",
    ".bash_history",
    ".zsh_history",
    ".psql_history",
    ".python_history",
    "authorized_keys",
    ".yarnrc.yml",
    ".yarnrc",
    "fish_history",
    "login data",
    ".dev.vars",
    ".sentryclirc",
    ".mysql_history",
    ".node_repl_history",
];
const STEM_WORDS: &[&str] = &[
    "secret",
    "secrets",
    "credential",
    "credentials",
    "token",
    "tokens",
    "password",
    "passwords",
    "passwd",
];
const KEY_EXTENSIONS: &[&str] = &["key", "pem", "p12", "pfx", "jks", "keystore", "tfvars"];
const CODE_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "md"];
const WORD_PREFIXES: &[&str] = &["api_key", "apikey", "api-key", "token"];
const CONTAINED_WORDS: &[&str] = &[
    "secret",
    "credential",
    "token",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
];
const TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template", ".dist"];
/// Folders that hold logins, in any position (the PLACES list of credentialPaths.ts).
const CREDENTIAL_PLACES: &[&[&str]] = &[
    &[".aws"],
    &[".kube"],
    &[".ssh"],
    &[".codex"],
    &[".gemini"],
    &[".local", "share", "opencode"],
    &[".wrangler"],
    &[".config", "wrangler"],
    &[".config", "rclone"],
    &[".config", "sops"],
    &[".config", "stripe"],
    &[".config", "doctl"],
    &[".config", "glab-cli"],
    &[".config", "hub"],
    &[".gnupg"],
    &[".docker"],
    &[".azure"],
    &[".password-store"],
    &[".mozilla"],
    &[".pki"],
    &[".npm"],
    &[".terraform.d"],
    &[".hermes"],
    &[".pi"],
    &[".omp"],
    &[".cursor"],
    &[".grok"],
    &[".config", "opencode"],
    &[".fly"],
    &[".railway"],
    &[".ngrok2"],
    &[".m2"],
    &[".zsh_sessions"],
    &[".git"],
    &["etc", "shadow"],
    &["etc", "gshadow"],
    &["etc", "passwd"],
    &["etc", "master.passwd"],
    &[".config", "gh"],
    &[".config", "gcloud"],
    &[".config", "hivra"],
    &[".config", "hermes"],
    &[".config", "fish", "config.fish"],
    &[".config", "github-copilot"],
    &[".config", "configstore"],
    &[".config", "ngrok"],
    &[".config", "op"],
    &[".vol"],
    &["library", "keychains"],
    &["library", "application support"],
    &["library", "cookies"],
    &["library", "safari"],
    &[".local", "share", "keyrings"],
    &["appdata", "roaming", "github cli"],
    &["appdata", "roaming", "rclone"],
    &["appdata", "roaming", "npm", "etc"],
    &["appdata", "local", "google", "chrome"],
    &["appdata", "local", "microsoft", "edge"],
];

/// `.env`, `.env.local`, `app.env`, but not the templates (`.env.example`), as credentialPaths.ts reads them.
fn env_file(file: &str) -> bool {
    let env = file == ".env"
        || (file.starts_with(".env.") && file.len() > 5)
        || (file.len() > 4 && file.ends_with(".env"));
    env && !TEMPLATE_SUFFIXES
        .iter()
        .any(|suffix| file.ends_with(suffix))
}

/// The stem and the extension of a name, as credentialPaths.ts's `parts` reads them.
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot < name.len() - 1 => (&name[..dot], &name[dot + 1..]),
        _ => (name, ""),
    }
}

/// Whether one file name is a login store, as credentialName (credentialPaths.ts) reads it. Round 4: a leading dot is no
/// part of the name, and any name with "history" in it is a store unless it is a source file.
fn credential_name(name: &str) -> bool {
    let file = name.to_ascii_lowercase();
    if file.is_empty() || file == "known_hosts" {
        return false;
    }
    if env_file(&file) {
        return true;
    }
    let bare = file.trim_start_matches('.');
    let (stem, ext) = split_name(bare);
    if CREDENTIAL_PREFIXES
        .iter()
        .any(|prefix| bare.starts_with(prefix))
    {
        return true;
    }
    if CREDENTIAL_NAMES.contains(&file.as_str())
        || CREDENTIAL_NAMES.contains(&bare)
        || STEM_WORDS.contains(&stem)
    {
        return true;
    }
    if KEY_EXTENSIONS.contains(&ext) {
        return true;
    }
    if bare.contains("history") && !CODE_EXTENSIONS.contains(&ext) {
        return true;
    }
    if CODE_EXTENSIONS.contains(&ext) {
        return false;
    }
    if WORD_PREFIXES.iter().any(|prefix| stem.starts_with(prefix)) {
        return true;
    }
    if !stem.contains(['_', '-']) || !CONTAINED_WORDS.iter().any(|word| stem.contains(word)) {
        return false;
    }
    !ext.is_empty() || stem.contains(['*', '?', '_', '-'])
}

/// Whether the folded segments of a path are a credential place or a credential file (credentialSegments).
fn credential_segments(parts: &[String]) -> bool {
    let Some(last) = parts.last() else {
        return false;
    };
    if last == "known_hosts" {
        return false;
    }
    let process_secret = parts.iter().enumerate().any(|(i, part)| {
        part == "proc"
            && matches!(
                parts.get(i + 2).map(String::as_str),
                Some("environ" | "cmdline" | "cwd" | "root")
            )
    });
    let in_place = CREDENTIAL_PLACES.iter().any(|place| {
        parts
            .windows(place.len())
            .any(|window| window.iter().map(String::as_str).eq(place.iter().copied()))
    });
    if in_place || process_secret {
        return true;
    }
    // A folder that holds logins (`secrets/`, `.ssh/`) makes every file under it a credential place too.
    if parts[..parts.len() - 1].iter().any(|part| {
        STEM_WORDS.contains(&part.as_str()) || CREDENTIAL_NAMES.contains(&part.as_str())
    }) {
        return true;
    }
    credential_name(last)
}

/// The pieces of a word that can name a path: the word, its bare form, the value after an `=`, the path glued to a short
/// option from its first slash, and the value after a short option's letter (`-f.netrc`). Mirrors credentialPaths.ts.
fn pieces(word: &str) -> Vec<&str> {
    let mut out = vec![word];
    let bare = word.trim_start_matches('-');
    if bare != word {
        out.push(bare);
    }
    if let Some((_, value)) = bare.split_once('=') {
        out.push(value);
    }
    if word.starts_with('-') {
        if let Some(at) = word.find('/') {
            out.push(&word[at..]);
        }
    }
    if word.len() > 2 && word.starts_with('-') && !word.starts_with("--") {
        if let Some(rest) = word.get(2..) {
            out.push(rest);
        }
    }
    out
}

/// Whether a search's option names its pattern (-e, -f, --regexp, --file, also in a cluster), so no bare word is one.
fn pattern_option(arg: &str) -> bool {
    let short_cluster =
        arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains(['e', 'f']);
    short_cluster || matches!(arg.split('=').next(), Some("--regexp" | "--file"))
}

/// The long options that turn the ignore rules off or show hidden files (credentialPaths.ts IGNORE_OFF_LONG).
const IGNORE_OFF_LONG: &[&str] = &[
    "--hidden",
    "--unrestricted",
    "--no-ignore",
    "--no-global-ignore",
    "--skip-vcs-ignores",
    "--all-types",
    "--all-text",
];

/// Whether one argument turns a search's ignore rules off (credentialPaths.ts unrestricted).
fn unrestricted(head: &str, arg: &str) -> bool {
    let name = arg.split('=').next().unwrap_or("");
    if name.starts_with("--") {
        let long = name.to_ascii_lowercase();
        return IGNORE_OFF_LONG.iter().any(|option| {
            long.starts_with(option) || (long.len() >= 4 && option.starts_with(long.as_str()))
        });
    }
    if !(name.starts_with('-') && name.len() > 1) {
        return false;
    }
    let cluster = &name[1..];
    if cluster.to_ascii_lowercase().contains('u') {
        return true;
    }
    match head {
        "rg" => cluster.contains('.'),
        "fd" => cluster.contains(['H', 'I']),
        "ag" => cluster.contains(['a', 't']),
        _ => false,
    }
}

/// Whether the command walks past the ignore rules (credentialPaths.ts ignoreOff).
fn ignore_off(head: &str, args: &[String]) -> bool {
    if head == "find" {
        return args.iter().any(|arg| {
            let name = arg.split('=').next().unwrap_or("").to_ascii_lowercase();
            name == "--hidden" || name.starts_with("--no-ignore")
        });
    }
    matches!(head, "rg" | "ag" | "grep" | "fd") && args.iter().any(|arg| unrestricted(head, arg))
}

/// Whether grep walks the tree: -r, -R, --recursive, --dereference-recursive, or -d recurse (credentialPaths.ts
/// grepRecurses).
fn grep_recurses(args: &[String]) -> bool {
    for (i, arg) in args.iter().enumerate() {
        let name = arg.split('=').next().unwrap_or("");
        let short = name.starts_with('-') && !name.starts_with("--") && name.len() > 1;
        if (short && name[1..].contains(['r', 'R']))
            || name == "--recursive"
            || name == "--dereference-recursive"
        {
            return true;
        }
        if name == "-d" || name == "--directories" {
            let mode = match arg.split_once('=') {
                Some((_, mode)) => Some(mode),
                None => args.get(i + 1).map(String::as_str),
            };
            if mode == Some("recurse") {
                return true;
            }
        }
    }
    false
}

fn rg_read(args: &[String]) -> Option<&'static str> {
    if has(args, &["--pre", "--pre-glob", "--hostname-bin"]) {
        Some("rg --pre runs a program")
    } else {
        None
    }
}

/// Why a timer's words name a login store or a folder outside the chat's own, or None. A timer has no folder, so anything
/// rooted, anything with a climb, and any dot-named part is outside (credentialPaths.ts with no folder).
fn names_login_or_outside(
    head: &str,
    args: &[String],
    list: Option<&ProtectedList>,
) -> Option<&'static str> {
    let Some(list) = list else {
        return Some(UNREADABLE_LIST);
    };
    if ignore_off(head, args) || (head == "grep" && grep_recurses(args)) {
        return Some(HELD);
    }
    let search = matches!(head, "rg" | "grep" | "ag" | "fd" | "find");
    let git = head == "git";
    let no_index = args.iter().any(|arg| arg == "--no-index");
    // A search's first bare word is its pattern, as grep reads it, unless an option names the pattern itself.
    let mut pattern_seen = search && head != "find" && args.iter().any(|arg| pattern_option(arg));
    for arg in args {
        let arg = arg.as_str();
        let words = pieces(arg);
        if search && words.iter().any(|piece| piece.contains(['*', '?', '['])) {
            return Some(HELD);
        }
        if search
            && head != "find"
            && !pattern_seen
            && !arg.starts_with('-')
            && !arg.contains(['.', '/', '~', '\\'])
        {
            pattern_seen = true;
            continue;
        }
        for piece in words {
            if piece.is_empty() {
                continue;
            }
            // This side has no Unicode folding, so a name that is not ASCII is held rather than judged.
            if !piece.is_ascii() {
                return Some(HELD);
            }
            let segments: Vec<&str> = piece.split(['/', '\\', ':']).collect();
            let climbs_or_hides = segments
                .iter()
                .any(|part| *part == ".." || (part.len() > 1 && part.starts_with('.')));
            let rooted = piece.starts_with(['~', '/', '\\']) || is_drive_path(piece);
            // Round 4, item 5: a git revision (`HEAD~1`) is not a file name, unless `--no-index` makes git compare files.
            let short_names_read = !(git && !no_index && !piece.contains(['/', '\\']));
            let short_name =
                short_names_read && segments.iter().any(|part| short_name_segment(part));
            let folded: Vec<String> = segments
                .iter()
                .filter(|part| !part.is_empty())
                .map(|part| fold_segment(part))
                .collect();
            if rooted
                || climbs_or_hides
                || short_name
                || braces_outside(piece)
                || (!folded.is_empty()
                    && (credential_segments(&folded) || protected_config(list, &folded)))
            {
                return Some(HELD);
            }
        }
    }
    None
}

/// None when autopilot would run this by itself. The reason otherwise. Same answers as `safeCommand`, plus the words a
/// read names in a login store (round 2).
/// An unreadable command is a reason, never an allow: `?` on the word list would invert that.
pub fn verdict(command: &str) -> Option<String> {
    verdict_with(command, protected_list())
}

/// `verdict` against a given list. A test passes a malformed list (None) to see that every read then holds.
fn verdict_with(command: &str, list: Option<&ProtectedList>) -> Option<String> {
    if command.chars().any(|c| SHELL_META.contains(&c)) {
        return Some("it chains, substitutes or redirects".into());
    }
    let Some(words) = shell_words(command.trim()) else {
        return Some("it can't be read plainly (a wildcard or an open quote)".into());
    };
    if words.is_empty() {
        return Some("it can't be read plainly (a wildcard or an open quote)".into());
    }
    let args = &words[1..];
    let why = match words[0].as_str() {
        "git" => git_read(args),
        "cargo" => cargo_read(args),
        "rg" => rg_read(args),
        "grep" | "ls" | "cat" | "head" | "tail" | "wc" | "pwd" => None,
        other => {
            return Some(format!("{other} isn't a read autopilot runs by itself"));
        }
    };
    why.or_else(|| names_login_or_outside(&words[0], args, list))
        .map(str::to_string)
}

/// The words to exec, with no shell, when `verdict` allows the command.
pub fn argv(command: &str) -> Result<Vec<String>, String> {
    if let Some(why) = verdict(command) {
        return Err(why.to_string());
    }
    let words = shell_words(command.trim())
        .ok_or_else(|| "it can't be read plainly (a wildcard or an open quote)".to_string())?;
    let program = words.first().map(String::as_str).unwrap_or("");
    if program.is_empty() || program.contains('/') || program.contains('\\') {
        return Err("it isn't a read autopilot runs by itself".into());
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_words_as_sh_does() {
        assert_eq!(
            shell_words(r#"rg -n 'a b' "c\"d" e\ f"#).unwrap(),
            ["rg", "-n", "a b", "c\"d", "e f"]
        );
        assert!(shell_words("rg foo *").is_none());
        assert!(shell_words("cat 'x").is_none());
        // An unreadable command is refused, not allowed.
        assert!(verdict("cargo +nightly test").is_some());
        assert!(verdict("rg foo *").is_some());
    }

    #[test]
    fn the_safe_table_allows_these_and_no_others() {
        for command in [
            "git status",
            "git status --porcelain",
            "git diff HEAD~1 -- src/app.ts",
            "git log --oneline -20",
            "git show HEAD:src/app.ts",
            "git branch",
            "git branch -a -v",
            "git branch --list 'hub/*'",
            "git branch --contains abc123",
            "ls -la src",
            "cat README.md",
            "rg -n 'foo bar' src",
            "rg \"fn main\" src-tauri",
            "grep -n TODO src/app.ts",
            "head -50 src/app.ts",
            "wc -l src/app.ts",
            "pwd",
            "cargo fmt --check",
            "cargo fmt --all --check",
            "rg -n token src",
            "cat src/token_store.ts",
            "cat ./src/app.ts",
            "git show HEAD:src/app.ts",
        ] {
            assert!(
                verdict(command).is_none(),
                "{command} -> {:?}",
                verdict(command)
            );
        }
    }

    #[test]
    fn the_safe_table_refuses_these() {
        for command in [
            "git status; rm -rf ~/data",
            "git status && rm -rf ~/data",
            "git status || true",
            "git status & rm -rf ~/data",
            "echo cm0gLXJmIH4vZGF0YQ== | base64 -d | sh",
            "rg -n 'foo|bar' src",
            "cat $(echo ~/.ssh/id_rsa)",
            "cat `echo x`",
            "cat ${HOME}/x",
            "git log > out.txt",
            "cat < /etc/passwd",
            "git status\nrm -rf ~/data",
            "(rm -rf ~/data)",
            "python3 -c \"import shutil\"",
            "gh pr merge 12 --admin",
            "rm -rf build",
            "npx vitest run",
            // Round 2 (C1): a test or build runs code the chat may have just written, so it waits.
            "npm test",
            "npm test -- src/features/autopilot",
            "npm run check",
            "npm run lint",
            "npm run build",
            "npm run check:web",
            "cargo test",
            "cargo test -p monocode --lib autopilot",
            "cargo check --workspace",
            "cargo clippy --all-targets -- -D warnings",
            "node --test scripts/hub-dev.test.mjs",
            "node --test 'scripts/**/*.test.mjs'",
            // Round 2 (low): a login store or a folder outside the chat's own, named by a word a read may still allow.
            "cat ~/.netrc",
            "cat ~/.ssh/config",
            "cat /Users/me/.aws/credentials",
            "cat /etc/hosts",
            "cat .env",
            "cat ./config/.env.local",
            "cat ../secret.txt",
            "cat secrets/token.txt",
            "cat keys/server.pem",
            "cat id_rsa.pub",
            "cat .git/config",
            "rg -g '.env*' TOKEN",
            "rg -g .env TOKEN src",
            "grep -rn TODO ~/Projects",
            "git show HEAD:.env",
            "ls ~",
            "/usr/bin/git status",
            "CI=1 npm test",
            "git push origin main",
            "git checkout main",
            "git -C /elsewhere status",
            "rg --pre=sh foo",
            "rg --pre sh foo",
            "rg '--pre=sh' foo",
            "rg --p\\re=sh foo",
            "rg --hostname-bin=/tmp/x foo",
            "git diff --output=/Users/ash/.zshrc",
            "git log --ext-diff",
            "git branch -D main",
            "git branch --delete main",
            "git branch -f main HEAD~3",
            "git branch new-branch",
            "npm test --script-shell=/tmp/evil",
            "npm run check --prefix ../other",
            "npm run deploy",
            "npm install",
            "cargo fmt",
            "cargo test --config build.rustc-wrapper=/tmp/evil",
            "cargo clippy --fix --allow-dirty",
            "cargo test --manifest-path /elsewhere/Cargo.toml",
            "cargo +nightly test",
            "cargo run",
            "node -e 'require(\"fs\")'",
            "node --test --import=./evil.mjs",
            "node --test --require ./evil.js",
            "node scripts/anything.mjs",
            "rg foo *",
            "rg foo {--pre=sh,.}",
            "ls ^x",
            "cat 'unclosed",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
    }
}

#[cfg(test)]
mod round3_tests {
    use super::*;

    // WP-101 review round 3. Each test is a case the TypeScript side (safeApproval.ts, credentialPaths.ts) already holds.

    #[test]
    fn the_shared_config_list_parses_and_names_the_configs() {
        let list = protected_list().expect("the shared list parses");
        assert!(list.files.contains(&"opencode.jsonc".to_string()));
        assert!(list.files.contains(&"bunfig.toml".to_string()));
        assert!(list.dirs.contains(&".omp".to_string()));
        assert!(list
            .suffixes
            .iter()
            .any(|suffix| suffix == &["config", "mise", "config.toml"].map(String::from).to_vec()));
    }

    #[test]
    fn a_timer_holds_the_tool_configs_by_name() {
        for command in [
            "cat opencode.jsonc",
            "cat ./mise.local.toml",
            "grep x lefthook-local.yml",
            "cat rust-toolchain.toml",
            "cat sub/bunfig.toml",
            "cat config/mise/config.toml",
            "ls .omp",
        ] {
            assert!(verdict(command).is_some(), "{command} should be held");
        }
    }

    #[test]
    fn a_glued_short_option_with_a_path_is_held() {
        assert!(verdict("rg -f/Users/me/x src").is_some());
        assert!(verdict("grep -f/etc/passwd README.md").is_some());
    }

    #[test]
    fn braces_naming_a_folder_outside_are_held() {
        assert!(verdict("cat '{/etc,src}/x'").is_some());
        assert!(verdict("ls '{../..,src}'").is_some());
    }

    #[test]
    fn a_word_that_is_not_ascii_is_held() {
        assert!(verdict("cat README-é.md").is_some());
    }

    #[test]
    fn a_plain_read_still_runs() {
        assert!(verdict("cat README.md").is_none());
        assert!(verdict("rg -n 'foo' src").is_none());
    }
}

#[cfg(test)]
mod round4_tests {
    use super::*;

    // WP-101 review round 4. Each case is one the TypeScript side (credentialPaths.ts, safeApproval.ts) holds too.

    #[test]
    fn a_dot_named_word_outside_the_folder_is_held_here_as_it_is_there() {
        for command in [
            "cat ~/.pi/agent/auth.json",
            "cat ~/.config/opencode/opencode.json",
            "cat ~/.cursor/mcp.json",
            "cat ~/.grok/user-settings.json",
            "cat ~/.claude/settings.json",
            "cat ~/.omp/agent/auth.json",
            "cat .gitignore",
            "cat src/.github/ci.yml",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
    }

    #[test]
    fn dot_named_secrets_and_history_files_are_held() {
        for command in [
            "cat .secrets",
            "cat .token",
            "cat .tokens",
            "cat .dev.vars",
            "cat ~/.zsh_sessions/abc.history",
            "ls ~/.zsh_sessions",
            "cat ~/.mysql_history",
            "cat ~/.node_repl_history",
            "cat ~/.fly/config.yml",
            "cat ~/.railway/config.json",
            "cat ~/.sentryclirc",
            "cat ~/.ngrok2/ngrok.yml",
            "cat ~/.m2/settings.xml",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
    }

    #[test]
    fn a_search_that_walks_or_turns_off_the_ignore_rules_is_held() {
        for command in [
            "grep -rn TODO src",
            "grep -R TODO src",
            "grep -d recurse TODO src",
            "grep --recursive TODO src",
            "rg --hidden foo src",
            "rg -uu foo src",
            "rg -.n foo src",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
    }

    #[test]
    fn textconv_and_glued_short_option_values_are_held() {
        assert!(verdict("git log --textconv -p").is_some());
        assert!(verdict("git diff --textconv HEAD~1").is_some());
        assert!(verdict("grep -f.netrc x README.md").is_some());
        assert!(verdict("grep -fsecrets README.md").is_some());
    }

    #[test]
    fn eight_dot_three_names_are_held_in_any_segment_but_a_git_revision() {
        for command in [
            "cat ./ENV~1",
            "cat ENV~1",
            "rg -n . ENV~1",
            "git diff --no-index NUL ENV~1",
            "cat CLAUDE~1.MD",
            "cat sub/CODEX~1/auth.json",
        ] {
            assert!(verdict(command).is_some(), "{command} was allowed");
        }
        // A git revision is not a file name, so it is read as before.
        assert!(verdict("git diff HEAD~1 -- src/app.ts").is_none());
        assert!(verdict("git log HEAD~3..HEAD").is_none());
    }

    #[test]
    fn a_search_pattern_is_not_a_path_and_an_option_names_one() {
        // A bare word is the pattern, so `token` is a search for the word.
        assert!(verdict("rg -n token src").is_none());
        // `-e` names the pattern, so the word after it is a file and is judged as one.
        assert!(verdict("rg -e foo secrets").is_some());
    }

    #[test]
    fn a_malformed_shared_list_holds_every_read_and_never_panics() {
        assert!(parse_protected("{ not json").is_none());
        assert!(parse_protected(r#"{"files": [1], "dirs": [], "pathSuffixes": []}"#).is_none());
        assert!(parse_protected(r#"{"files": [], "dirs": [], "pathSuffixes": "x"}"#).is_none());
        // With no list, the verdict holds before anything else is read.
        assert!(verdict_with("git status", None).is_some());
        assert!(verdict_with("cat README.md", None).is_some());
        // The real list parses.
        assert!(verdict_with("cat README.md", protected_list()).is_none());
    }
}

#[cfg(test)]
mod parity {
    use super::*;

    /// The same commands the TypeScript timer rule is tested on (src/shared/security/approvalParity.json). Each case says
    /// whether a timer holds it; both sides must agree, and this side must hold whatever the TypeScript side holds.
    #[test]
    fn the_timer_check_holds_exactly_the_commands_the_typescript_side_holds() {
        let file: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/security/approvalParity.json"
        ))
        .expect("the parity cases parse");
        let cases = file["cases"].as_array().expect("a list of cases");
        assert!(
            cases.len() > 90,
            "the shared set is too small to mean anything"
        );
        for case in cases {
            let command = case["command"].as_str().expect("a command");
            let held = case["held"].as_bool().expect("a held flag");
            assert_eq!(
                verdict(command).is_some(),
                held,
                "parity: {command} (TypeScript holds it: {held})"
            );
        }
    }
}
