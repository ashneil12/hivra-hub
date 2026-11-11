//! The webview's question veto and path-segment credential check, for a captain answer.
//! `questionVeto` in reviewerRules.ts and `credentialInText` in credentialPaths.ts. A shape that cannot be read holds.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

const SEND: &str = "This sends a message or reaches someone else, so it waits for you.";
const DELETE: &str = "This deletes something, so it waits for you.";
const PAY: &str = "This moves money or books something paid, so it waits for you.";
const PUBLISH: &str = "This publishes something for others to see, so it waits for you.";
const ACCOUNT: &str = "This changes an account, a login or access, so it waits for you.";
const COMMIT: &str = "This signs or agrees to something in your name, so it waits for you.";
const FORCEFUL: &str =
    "This forces or overwrites something in a way that can't be undone, so it waits for you.";
const UNREADABLE: &str = "The reviewer couldn't read what this would do, so it waits for you.";

const ASK_WORDS: &[(&str, &str)] = &[
    (
        SEND,
        "send|sends|sent|email|emails|emailed|mail|message|messages|dm|dms|sms|tweet|tweets|tweeted|post|posts|posted|reply|replies|forward|forwards|share|shares|shared|sharing|invite|invites|invited|inviting|broadcast|broadcasts|announce|announces|announced|comment|comments|notify|notifies|notified|mention|mentions|ping|pings|pinged|remind|reminds|reminded|text|texted|tell|tells|told|contact|contacts|submit|submits|submitted|submitting",
    ),
    (
        DELETE,
        "delete|deletes|deleted|deleting|delete_all|remove|removes|removed|removing|removal|rm|unlink|erase|erases|erased|drop|drops|dropped|dropping|purge|purges|purged|wipe|wipes|wiped|destroy|destroys|destroyed|destroying|truncate|truncates|truncated|clear|clears|cleared|clearing|trash|uninstall|uninstalls|revoke|revokes|revoked|revoking|overwrite|overwrites|overwrote|overwriting|terminate|terminates|terminated|kill|kills|killed|reset|resets|resetting|archive|archives|archived|archiving",
    ),
    (
        PAY,
        "pay|pays|paid|paying|payment|payments|wire|wires|wired|wiring|remit|remits|remitted|remittance|transfer|transfers|transferred|transferring|charge|charges|charged|refund|refunds|refunded|withdraw|withdraws|withdrew|deposit|deposits|invoice|invoices|purchase|purchases|buy|buys|bought|buying|sell|sells|sold|order|orders|ordered|ordering|stripe|checkout|billing|subscribe|subscribes|subscribed|subscription|subscriptions|unsubscribe|unsubscribes|unsubscribed|unsubscribing|payout|payouts|donate|donates|donation|book|books|booked|booking|reserve|reserves|reserved|reservation",
    ),
    (
        PUBLISH,
        "publish|publishes|published|publishing|unpublish|unpublishes|unpublished|unpublishing|republish|republishes|deploy|deploys|deployed|deploying|deployment|release|releases|released|releasing|push|pushes|pushed|pushing|ship|ships|shipped|merge|merges|merged|merging|upload|uploads|uploaded|uploading|public|expose|exposes|exposed|exposing",
    ),
    (
        ACCOUNT,
        "login|logout|signin|signout|sign_up|signup|auth|authenticate|authentication|authorization|authorise|authorises|authorised|authorizing|authorize|authorizes|authorized|oauth|sso|password|passwd|credential|credentials|permission|permissions|grant|grants|granted|granting|role|roles|admin|admin_access|key|keys|token|tokens|secret|secrets|identity|mfa|2fa|totp|reset_password|change_password|env|ssh|keychain|cookie|cookies|session|sessions|private|collaborator|collaborators|collaboration|migrate|migrates|migrated|migrating|migration|migrations|rotate|rotates|rotating|account|accounts|disable|disables|disabled|disabling|ban|bans|banned|banning|lock|locks|locked|locking|chmod|chown",
    ),
    (COMMIT, "sign|signs|signed|signing|signature"),
    (
        FORCEFUL,
        "force|forces|forced|forcing|killall|pkill|rebase|rebases|rebased|rebasing|squash|squashes|squashed|squashing",
    ),
];

/// Phrases from reviewerRules.ts that the `regex` crate can compile. A pattern that does not compile holds every question.
const PHRASES: &[(&str, &str)] = &[
    (r"\bgo(?:es|ing)? live\b", PUBLISH),
    (
        r"\b(?:make|makes|making|made) (?:it |this |the repo |the repository |the project |the site |the bucket )?public\b",
        PUBLISH,
    ),
    (r"\bopen[- ]sourc(?:e|es|ed|ing)\b", PUBLISH),
    (
        r"\bopen(?:s|ed|ing)? (?:a |an |the )?(?:pr|mrs?|pull request|merge request)\b",
        PUBLISH,
    ),
    (r"\bclean(?:s|ed|ing)? out\b", DELETE),
    (
        r"\breset\s+(?:--?)?hard\b|\breset\s+-{1,2}[a-z]*h[a-z]*\b",
        FORCEFUL,
    ),
    (r"\bdirect (?:message|messages|messaging|dm)\b", SEND),
    (r"\bloop (?:in|into)\b", SEND),
    (
        r"\bclos(?:e|es|ed|ing) (?:a |an |the |my |our |this )?(?:user )?accounts?\b",
        ACCOUNT,
    ),
    (
        r"\bclos(?:e|es|ed|ing) (?:a |an |the |this |our )?(?:repo|repos|repository|repositories|issue|issues|pr|prs|pull requests?|merge requests?)\b",
        DELETE,
    ),
    (r"\bforce[- ]push(?:es|ed|ing)?\b", FORCEFUL),
    (
        r"\bshut(?:s|ting)?[- ]?down\b|\bshut(?:s|ting)? (?:\w+ ){1,3}down\b",
        FORCEFUL,
    ),
    (
        r"\bpower(?:s|ed|ing)?[- ]?(?:off|down)\b|\bpoweroff\b|\bpower(?:s|ed|ing)? (?:\w+ ){1,3}(?:off|down)\b",
        FORCEFUL,
    ),
];

fn word_kind() -> &'static HashMap<String, &'static str> {
    static MAP: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut map = HashMap::new();
        for (reason, words) in ASK_WORDS {
            for word in words.split('|') {
                map.entry(word.to_string()).or_insert(*reason);
            }
        }
        map
    })
}

struct Phrase {
    pattern: Regex,
    reason: &'static str,
}

fn phrases() -> &'static (Vec<Phrase>, bool) {
    static SET: OnceLock<(Vec<Phrase>, bool)> = OnceLock::new();
    SET.get_or_init(|| {
        let mut compiled = Vec::new();
        let mut broken = false;
        for (pattern, reason) in PHRASES {
            match Regex::new(pattern) {
                Ok(pattern) => compiled.push(Phrase { pattern, reason }),
                Err(_) => broken = true,
            }
        }
        (compiled, broken)
    })
}

fn tidy(word: &str) -> String {
    word.trim_matches(|c: char| c == '\'' || c == '"' || c == '`' || c == ',' || c == ';')
        .to_string()
}

fn plain_words(text: &str) -> Vec<String> {
    let folded = nfkc_lower(text);
    let mut tokens = Vec::new();
    let mut current = String::new();
    for c in folded.chars() {
        if c.is_ascii_alphanumeric() || c == '\'' {
            current.push(c);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    let mut words = tokens.clone();
    let mut run_start: Option<usize> = None;
    for i in 0..=tokens.len() {
        let single = i < tokens.len() && tokens[i].chars().count() == 1;
        if single {
            if run_start.is_none() {
                run_start = Some(i);
            }
            continue;
        }
        if let Some(start) = run_start.take() {
            let run = &tokens[start..i];
            for from in 0..run.len() {
                let end = (from + 24).min(run.len());
                for to in (from + 2)..=end {
                    words.push(run[from..to].join(""));
                }
            }
        }
    }
    words
}

fn nfkc_lower(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfkc()
        .filter(|c| !super::is_ignorable(*c))
        .collect::<String>()
        .to_lowercase()
}

fn normalised_phrase(text: &str) -> String {
    let folded = nfkc_lower(text).replace('_', " ");
    let mut out = String::new();
    let mut space = false;
    for c in folded.chars() {
        if c.is_whitespace() {
            if !out.is_empty() {
                space = true;
            }
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    out
}

fn veto_part(part: &str) -> Option<&'static str> {
    let (phrases, broken) = phrases();
    if *broken {
        return Some(UNREADABLE);
    }
    let phrase = normalised_phrase(part);
    for item in phrases {
        if item.pattern.is_match(&phrase) {
            return Some(item.reason);
        }
    }
    let kinds = word_kind();
    for word in plain_words(part) {
        if let Some(reason) = kinds.get(tidy(&word).as_str()) {
            return Some(*reason);
        }
    }
    None
}

/// Why this question is not the captain's to answer, or none. The same words as the webview's `questionVeto`.
pub fn question_veto(decision: &super::Decision, proposed: &str) -> Option<&'static str> {
    if decision.question.trim().is_empty() {
        return Some(UNREADABLE);
    }
    let mut parts: Vec<&str> = vec![decision.question.as_str()];
    if let Some(recommended) = decision.recommended.as_deref() {
        if !recommended.trim().is_empty() {
            parts.push(recommended);
        }
    }
    for option in &decision.options {
        if !option.trim().is_empty() {
            parts.push(option.as_str());
        }
    }
    if !proposed.trim().is_empty() {
        parts.push(proposed);
    }
    for part in parts {
        if let Some(why) = veto_part(part) {
            return Some(why);
        }
    }
    None
}

// ---- path segments: credentialInText ---------------------------------------------------------------

const PLACES: &[&[&str]] = &[
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
    &[".git"],
    &["etc", "shadow"],
    &["etc", "gshadow"],
    &["etc", "passwd"],
    &["etc", "master.passwd"],
    &[".config", "gh"],
    &[".config", "gcloud"],
    &[".config", "hivra"],
    &[".config", "hermes"],
    &["library", "keychains"],
    &["library", "application support"],
    &["library", "cookies"],
    &["library", "safari"],
    &[".local", "share", "keyrings"],
];

const NAMES: &[&str] = &[
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

const PREFIXES: &[&str] = &[
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "service-account",
    "terraform.tfstate",
    "kubeconfig",
];
const WORD_PREFIXES: &[&str] = &["api_key", "apikey", "api-key", "token"];
const STEMS: &[&str] = &[
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
const CONTAINED: &[&str] = &[
    "secret",
    "credential",
    "token",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
];

fn contains_name(name: &str) -> bool {
    NAMES.contains(&name)
}

fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => &name[dot + 1..],
        _ => "",
    }
}

fn credential_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.is_empty() || lower == "known_hosts" {
        return false;
    }
    if env_file(&lower) {
        return true;
    }
    let bare = lower.trim_start_matches('.');
    let ext = extension_of(bare);
    let stem = if ext.is_empty() {
        bare
    } else {
        &bare[..bare.len() - ext.len() - 1]
    };
    if PREFIXES.iter().any(|prefix| bare.starts_with(prefix)) {
        return true;
    }
    if contains_name(&lower) || contains_name(bare) || STEMS.contains(&stem) {
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
    let joined = stem.contains('_') || stem.contains('-');
    joined
        && CONTAINED.iter().any(|word| stem.contains(word))
        && (!ext.is_empty() || stem.contains('_') || stem.contains('-'))
}

fn env_file(lower: &str) -> bool {
    let env = lower == ".env" || lower.starts_with(".env.") || lower.ends_with(".env");
    let template = lower.ends_with(".example")
        || lower.ends_with(".sample")
        || lower.ends_with(".template")
        || lower.ends_with(".dist");
    env && !template
}

fn fold_path(path: &str) -> String {
    let folded = nfkc_lower(path.trim()).replace('\\', "/");
    folded
        .split('/')
        .map(|part| {
            if part.chars().all(|c| c == '.') {
                part.to_string()
            } else {
                part.trim_end_matches(['.', ' ']).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn resolve_segments(folded: &str) -> Vec<String> {
    let mut rest = folded;
    let mut rooted = rest.starts_with('/');
    if rest.len() >= 2 && rest.as_bytes()[0].is_ascii_alphabetic() && rest.as_bytes()[1] == b':' {
        rooted = true;
        rest = &rest[2..];
    }
    let tilde = rest == "~" || rest.starts_with("~/");
    let anchored = rooted || tilde;
    let mut raw: Vec<&str> = rest.split('/').collect();
    let mut segments = Vec::new();
    if tilde {
        if !raw.is_empty() {
            raw.remove(0);
        }
        segments.push("users".to_string());
        segments.push("~".to_string());
    }
    for part in raw {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if segments.last().is_some_and(|last| last != "..") {
                segments.pop();
            } else if !anchored {
                segments.push("..".to_string());
            }
            continue;
        }
        segments.push(part.to_string());
    }
    segments
}

fn place_among(parts: &[String]) -> bool {
    PLACES.iter().any(|place| {
        parts.windows(place.len()).any(|window| {
            window
                .iter()
                .zip(place.iter())
                .all(|(part, expected)| part == expected)
        })
    })
}

fn credential_segments(parts: &[String]) -> bool {
    if parts.is_empty() {
        return false;
    }
    if parts.last().is_some_and(|part| part == "known_hosts") {
        return false;
    }
    if place_among(parts) {
        return true;
    }
    if parts[..parts.len() - 1]
        .iter()
        .any(|part| STEMS.contains(&part.as_str()) || contains_name(part))
    {
        return true;
    }
    credential_name(parts.last().map(String::as_str).unwrap_or(""))
}

fn short_name(part: &str) -> bool {
    // `ENV~1` or `AUTH~1.JSO`. A git revision `HEAD~1` is excluded by the caller.
    let Some((head, tail)) = part.split_once('~') else {
        return false;
    };
    if head.is_empty() || head.len() > 8 || head.contains('/') || head.contains('\\') {
        return false;
    }
    let (digits, ext) = tail.split_once('.').unwrap_or((tail, ""));
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) && ext.len() <= 3
}

fn credential_path(path: &str, short_names: bool) -> bool {
    let folded = fold_path(path);
    let written: Vec<String> = folded
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if written.is_empty() {
        return false;
    }
    let named: Vec<String> = written
        .iter()
        .flat_map(|part| {
            part.split(':')
                .filter(|piece| !piece.is_empty())
                .map(str::to_string)
        })
        .collect();
    if short_names && named.iter().any(|part| short_name(part)) {
        return true;
    }
    credential_segments(&named) || credential_segments(&resolve_segments(&folded))
}

/// Whether prose names a credential file. Only path-shaped words count, so ordinary text is left alone.
pub fn credential_in_text(text: &str) -> bool {
    let mut token = String::new();
    let check = |token: &str| -> bool {
        if token.is_empty() {
            return false;
        }
        if token.chars().all(|c| matches!(c, '.' | '~' | '/' | '-')) {
            return false;
        }
        if !token.contains('/') && !token.contains('.') && !token.contains('~') {
            return false;
        }
        let revision = !token.contains('/')
            && !token.contains('\\')
            && !token.contains(':')
            && token.split_once('~').is_some_and(|(head, tail)| {
                !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) && !tail.is_empty()
            });
        credential_path(token, !revision)
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '~' | '/' | '-') {
            token.push(c);
        } else if check(&token) {
            return true;
        } else {
            token.clear();
        }
    }
    check(&token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_veto_phrase_compiles() {
        for (pattern, _) in PHRASES {
            Regex::new(pattern).unwrap_or_else(|error| panic!("{pattern}: {error}"));
        }
    }
}
