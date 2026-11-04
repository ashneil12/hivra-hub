//! Whether a plugin can run here (WP-31 build step 2): the platforms it declares and the Hivra versions it supports,
//! checked before anything is downloaded where the source can say (an npm package's registry entry, a git commit's
//! `plugin.json` read from the object store before checkout), and again on the downloaded manifest.
//!
//! A plugin declares them in `plugin.json`'s Hivra extension:
//!
//! ```json
//! "extensions": { "hivra": { "platforms": ["macos", "linux"], "hivraVersion": ">=0.16.0, <1" } }
//! ```
//!
//! An npm package may also use npm's own `os` field (`darwin`, `!win32`…) and `engines.hivra`. Nothing declared means
//! every platform and every version.

use serde_json::Value;

use super::hivra::NAMESPACE;

/// The platform this build runs on, in Hivra's words.
pub fn this_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// This build's version.
pub fn this_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Where a check runs: this platform and this version, or (tests) any other.
#[derive(Clone, Debug)]
pub struct Target {
    pub platform: String,
    pub version: String,
}

impl Target {
    pub fn here() -> Self {
        Self {
            platform: this_platform().into(),
            version: this_version().into(),
        }
    }
}

/// Every spelling a platform goes by: Hivra's, npm's (`process.platform`) and Rust's.
fn platform_name(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "macos" | "darwin" | "mac" | "osx" => Some("macos"),
        "windows" | "win32" | "win" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

/// `platforms` lists where it runs (npm's `!name` excludes one). `None` when it runs on `platform`.
fn platform_problem(platforms: &[String], platform: &str) -> Option<String> {
    if platforms.is_empty() {
        return None;
    }
    let mut allowed = Vec::new();
    for entry in platforms {
        let (negated, name) = match entry.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, entry.as_str()),
        };
        let Some(name) = platform_name(name) else {
            continue; // a platform Hivra doesn't run on (freebsd, aix…) changes nothing here
        };
        if negated && name == platform {
            return Some(format!("it says it doesn't run on {}", pretty(platform)));
        }
        if !negated {
            allowed.push(name);
        }
    }
    let only_negations = platforms.iter().all(|p| p.starts_with('!'));
    if only_negations || allowed.contains(&platform) {
        return None;
    }
    allowed.sort_unstable();
    allowed.dedup();
    let list = if allowed.is_empty() {
        "no platform Hivra runs on".to_string()
    } else {
        allowed.iter().map(|p| pretty(p)).collect::<Vec<_>>().join(" and ")
    };
    Some(format!("it only runs on {list}, not {}", pretty(platform)))
}

fn pretty(platform: &str) -> &'static str {
    match platform {
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Linux",
    }
}

/// An npm-style (`>=0.16.0 <1 || ^2`) or Cargo-style (`>=0.16, <1`) range. `Err` names what can't be read.
fn version_matches(range: &str, version: &str) -> Result<bool, String> {
    let version = semver::Version::parse(version.trim())
        .map_err(|e| format!("Hivra's own version \"{version}\" can't be read: {e}"))?;
    let range = range.trim();
    if range.is_empty() || range == "*" {
        return Ok(true);
    }
    for alternative in range.split("||") {
        let cargo = cargo_style(alternative);
        let req = semver::VersionReq::parse(&cargo)
            .map_err(|_| format!("its Hivra version range \"{range}\" can't be read"))?;
        if req.matches(&version) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// npm separates comparators with spaces, Cargo with commas; `>= 1.0` keeps its operator attached.
fn cargo_style(alternative: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut pending_op = String::new();
    for token in alternative.split([',', ' ']).filter(|t| !t.is_empty()) {
        if token.chars().all(|c| matches!(c, '<' | '>' | '=' | '^' | '~')) {
            pending_op.push_str(token);
            continue;
        }
        parts.push(format!("{}{token}", std::mem::take(&mut pending_op)));
    }
    if parts.is_empty() {
        "*".into()
    } else {
        parts.join(", ")
    }
}

/// What a plugin says about where it runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Declared {
    pub platforms: Vec<String>,
    pub hivra_version: Option<String>,
}

impl Declared {
    /// From a `plugin.json` value (`extensions.hivra`). A wrong-typed field is a refusal, not "everywhere".
    pub fn from_manifest(manifest: &Value) -> Result<Self, String> {
        let ext = manifest
            .get("extensions")
            .and_then(|e| e.get(NAMESPACE))
            .cloned()
            .unwrap_or(Value::Null);
        Self::from_fields(ext.get("platforms"), ext.get("hivraVersion"), "plugin.json")
    }

    /// From an npm registry entry or package.json: npm's `os` and `engines.hivra`.
    pub fn from_npm(package: &Value) -> Result<Self, String> {
        let engines = package.get("engines").and_then(|e| e.get(NAMESPACE));
        Self::from_fields(package.get("os"), engines, "package.json")
    }

    fn from_fields(
        platforms: Option<&Value>,
        version: Option<&Value>,
        file: &str,
    ) -> Result<Self, String> {
        let platforms = match platforms {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| format!("{file}: its platforms must be a list of names"))
                })
                .collect::<Result<_, _>>()?,
            Some(Value::String(one)) => vec![one.clone()],
            Some(_) => return Err(format!("{file}: its platforms must be a list of names")),
        };
        let hivra_version = match version {
            None | Some(Value::Null) => None,
            Some(Value::String(range)) => Some(range.clone()),
            Some(_) => return Err(format!("{file}: its Hivra version range must be text")),
        };
        Ok(Self {
            platforms,
            hivra_version,
        })
    }

    /// `Err` with a plain reason when it can't run on `target`.
    pub fn check(&self, target: &Target) -> Result<(), String> {
        if let Some(why) = platform_problem(&self.platforms, &target.platform) {
            return Err(format!("This plugin can't be installed here: {why}."));
        }
        if let Some(range) = &self.hivra_version {
            match version_matches(range, &target.version) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(format!(
                        "This plugin can't be installed here: it needs Hivra {range}, and this is {}.",
                        target.version
                    ))
                }
                Err(why) => return Err(format!("This plugin can't be installed here: {why}.")),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(platform: &str, version: &str) -> Target {
        Target {
            platform: platform.into(),
            version: version.into(),
        }
    }

    #[test]
    fn platforms_take_every_spelling_and_negation() {
        let mac = target("macos", "0.16.9");
        let win = target("windows", "0.16.9");
        let d = |p: &[&str]| Declared {
            platforms: p.iter().map(|s| s.to_string()).collect(),
            hivra_version: None,
        };
        assert!(d(&[]).check(&mac).is_ok());
        assert!(d(&["darwin", "linux"]).check(&mac).is_ok());
        let refused = d(&["darwin", "linux"]).check(&win).unwrap_err();
        assert!(refused.contains("only runs on Linux and macOS, not Windows"), "{refused}");
        assert!(d(&["!win32"]).check(&mac).is_ok());
        assert!(d(&["!win32"]).check(&win).unwrap_err().contains("doesn't run on Windows"));
        assert!(d(&["freebsd"]).check(&mac).unwrap_err().contains("no platform Hivra runs on"));
    }

    #[test]
    fn version_ranges_read_npm_and_cargo_style() {
        let here = |range: &str| Declared {
            platforms: Vec::new(),
            hivra_version: Some(range.into()),
        };
        let v = target("linux", "0.16.9");
        for ok in [">=0.16.0", ">=0.16, <1", ">= 0.16.0 < 1.0.0", "^0.16", "~0.16.2", "*", "<0.10 || >=0.16"] {
            assert!(here(ok).check(&v).is_ok(), "{ok}");
        }
        for no in [">=0.17", "<0.16.9", "^1", "0.15.0"] {
            let why = here(no).check(&v).unwrap_err();
            assert!(why.contains("needs Hivra") && why.contains("this is 0.16.9"), "{no}: {why}");
        }
        assert!(here("soon").check(&v).unwrap_err().contains("can't be read"));
    }

    #[test]
    fn declarations_come_from_the_manifest_extension_and_npm_fields() {
        let manifest = json!({ "extensions": { "hivra": { "platforms": ["linux"], "hivraVersion": ">=1" } } });
        assert_eq!(
            Declared::from_manifest(&manifest).unwrap(),
            Declared {
                platforms: vec!["linux".into()],
                hivra_version: Some(">=1".into())
            }
        );
        assert_eq!(Declared::from_manifest(&json!({})).unwrap(), Declared::default());
        assert!(Declared::from_manifest(&json!({ "extensions": { "hivra": { "platforms": 3 } } })).is_err());
        let npm = json!({ "os": ["!win32"], "engines": { "hivra": "^0.16", "node": ">=18" } });
        assert_eq!(
            Declared::from_npm(&npm).unwrap(),
            Declared {
                platforms: vec!["!win32".into()],
                hivra_version: Some("^0.16".into())
            }
        );
    }
}
