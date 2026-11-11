// WP-178: the protected-paths file. Files that decide what runs next (git hooks and config, shell profiles, and each
// CLI's settings, hooks, commands and skills) and that an agent must not change silently. Paths are checkout-relative
// (".git/hooks/**") or home-relative ("~/.zshrc"). The after-turn report names what a turn touched; it never blocks a
// write and never reverts a file. Blocking is the macOS sandbox profile (src-tauri/src/agent_sandbox.rs), on by setting.
// The secret places (SSH keys, cloud logins, keychains) and the shell profiles come from the `homeSecrets` section of the
// shared list src/shared/security/agentConfigPaths.json, the same file the sandbox profile reads (agent_sandbox.rs).
import sharedList from "../../../shared/security/agentConfigPaths.json";

export type ProtectedRule = {
  /** A glob: `**` any depth, `*` one segment. Checkout paths are root-relative; home paths start with `~/`. */
  pattern: string;
  /** Why a change matters, in plain words. Shown in the report. */
  why: string;
};

const HOME_SECRETS = sharedList.homeSecrets;

export const PROTECTED_PATHS: readonly ProtectedRule[] = [
  // Git: a hook runs on the next commit, push or checkout; config can point hooks or fsmonitor at any command.
  { pattern: ".git/hooks/**", why: "a git hook runs on the next commit, push or checkout" },
  { pattern: ".git/config", why: "git config can point hooks or fsmonitor at any command" },

  // Each CLI's project settings, hooks, commands and skills (the checkout's own copies).
  { pattern: ".claude/settings.json", why: "Claude Code settings decide its permissions and hooks" },
  { pattern: ".claude/settings.local.json", why: "Claude Code local settings decide its permissions and hooks" },
  { pattern: ".claude/hooks/**", why: "Claude Code hooks run on its tool calls" },
  { pattern: ".claude/commands/**", why: "Claude Code commands run when someone types them" },
  { pattern: ".claude/skills/**", why: "Claude Code skills change what the agent is told to do" },
  { pattern: ".claude/agents/**", why: "Claude Code subagent definitions change what workers run" },
  { pattern: ".codex/config.toml", why: "Codex settings decide its sandbox and approvals" },
  { pattern: ".codex/skills/**", why: "Codex skills change what the agent is told to do" },
  { pattern: ".cursor/mcp.json", why: "Cursor MCP config starts commands on its own" },
  { pattern: ".cursor/rules/**", why: "Cursor rules change what the agent is told to do" },
  { pattern: ".cursor/skills/**", why: "Cursor skills change what the agent is told to do" },
  { pattern: ".opencode/opencode.json", why: "OpenCode settings decide what it runs" },
  { pattern: ".opencode/opencode.jsonc", why: "OpenCode settings decide what it runs" },
  { pattern: ".opencode/skills/**", why: "OpenCode skills change what the agent is told to do" },
  { pattern: ".agents/skills/**", why: "shared agent skills change what every CLI is told to do" },
  { pattern: ".hermes/skills/**", why: "Hermes skills change what the agent is told to do" },
  { pattern: ".devin/skills/**", why: "Devin skills change what the agent is told to do" },
  { pattern: ".config/devin/skills/**", why: "Devin skills change what the agent is told to do" },
  { pattern: ".gemini/antigravity/skills/**", why: "Antigravity skills change what the agent is told to do" },

  // Shell profiles: run in every new terminal, including the ones Hivra opens (the shared list's shellProfiles).
  ...HOME_SECRETS.shellProfiles.map((file) => ({
    pattern: `~/${file}`,
    why: "a shell profile runs in every new terminal or shell",
  })),

  // The person's own CLI settings, hooks, commands and skills.
  { pattern: "~/.claude/settings.json", why: "Claude Code settings decide its permissions and hooks" },
  { pattern: "~/.claude/settings.local.json", why: "Claude Code local settings decide its permissions and hooks" },
  { pattern: "~/.claude/hooks/**", why: "Claude Code hooks run on its tool calls" },
  { pattern: "~/.claude/commands/**", why: "Claude Code commands run when someone types them" },
  { pattern: "~/.claude/skills/**", why: "Claude Code skills change what the agent is told to do" },
  { pattern: "~/.claude/agents/**", why: "Claude Code subagent definitions change what workers run" },
  { pattern: "~/.codex/config.toml", why: "Codex settings decide its sandbox and approvals" },
  { pattern: "~/.codex/skills/**", why: "Codex skills change what the agent is told to do" },
  { pattern: "~/.cursor/mcp.json", why: "Cursor MCP config starts commands on its own" },
  { pattern: "~/.cursor/rules/**", why: "Cursor rules change what the agent is told to do" },
  { pattern: "~/.config/opencode/**", why: "OpenCode settings decide what it runs" },
];

/** A glob to an anchored regex: `**` crosses folders, `*` stays in one, everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const COMPILED = PROTECTED_PATHS.map((rule) => ({ rule, re: globToRegExp(rule.pattern) }));

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The first protected rule a path matches, or null. A path is checkout-relative or starts with `~/`. */
export function matchProtected(path: string): ProtectedRule | null {
  const p = normalize(path);
  const hit = COMPILED.find(({ re }) => re.test(p));
  return hit ? hit.rule : null;
}

/** The paths whose content differs between two fingerprint snapshots (added, removed or changed), sorted. */
export function diffFingerprints(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

/** `protected`: a file that decides what runs next. `secret`: a place of logins or keys. */
export type ProtectedKind = "protected" | "secret";

export type ProtectedTouch = { path: string; pattern: string; why: string; kind: ProtectedKind };

/** What the after-turn check reports. It names what changed and never blocks or reverts anything. */
export type ProtectedTouchReport = { touched: ProtectedTouch[]; summary: string };

/**
 * The fold the shared list's matcher uses on a name (src-tauri/src/delivery/protected.rs `fold`): NFKC, lower case, the
 * long s (U+017F) to s, and trailing dots and spaces removed. `.ſSH.` and `.ssh` are the same folder on a Mac or Windows.
 */
export function foldName(segment: string): string {
  return segment.normalize("NFKC").toLowerCase().replace(/\u017f/g, "s").replace(/[. ]+$/, "");
}

type SecretRule = ProtectedRule & { segments: string[]; folder: boolean };

/**
 * The secret places, home-relative, from the shared list's `homeSecrets`. A folder holds everything under it; a file is
 * that file only. The CLIs' own login files are reported and never denied (the sandbox does not deny them either).
 * Read-only for the check: nothing is blocked here.
 */
const SECRET_RULES: readonly SecretRule[] = [
  ...HOME_SECRETS.dirs.map((dir) => ({
    pattern: `~/${dir}/**`,
    why: "a folder of logins or keys",
    segments: dir.split("/").map(foldName),
    folder: true,
  })),
  ...HOME_SECRETS.files.map((file) => ({
    pattern: `~/${file}`,
    why: "a file of logins",
    segments: file.split("/").map(foldName),
    folder: false,
  })),
  ...HOME_SECRETS.cliLoginFiles.map((file) => ({
    pattern: `~/${file}`,
    why: "a coding CLI's own login file",
    segments: file.split("/").map(foldName),
    folder: false,
  })),
];

export const SECRET_PATHS: readonly ProtectedRule[] = SECRET_RULES.map(({ pattern, why }) => ({ pattern, why }));

/** The first secret place a home path names, or null. Only `~/` paths can be secret places. */
export function matchSecret(path: string): ProtectedRule | null {
  const p = normalize(path);
  if (!p.startsWith("~/")) return null;
  const segments = p
    .slice(2)
    .split("/")
    .filter((segment) => segment !== "")
    .map(foldName);
  const hit = SECRET_RULES.find((rule) => {
    const inside = rule.folder ? segments.length >= rule.segments.length : segments.length === rule.segments.length;
    return inside && rule.segments.every((segment, i) => segments[i] === segment);
  });
  return hit ? { pattern: hit.pattern, why: hit.why } : null;
}

export function reportProtectedTouches(changedPaths: readonly string[]): ProtectedTouchReport {
  const seen = new Set<string>();
  const touched: ProtectedTouch[] = [];
  for (const raw of changedPaths) {
    const path = normalize(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    const rule = matchProtected(path);
    if (rule) {
      touched.push({ path, pattern: rule.pattern, why: rule.why, kind: "protected" });
      continue;
    }
    const secret = matchSecret(path);
    if (secret) touched.push({ path, pattern: secret.pattern, why: secret.why, kind: "secret" });
  }
  const summary =
    touched.length === 0
      ? "Nothing protected changed."
      : `${touched.length} protected ${touched.length === 1 ? "path" : "paths"} changed: ${touched
          .map((t) => t.path)
          .join(", ")}. Reported only; nothing was blocked or reverted.`;
  return { touched, summary };
}

/**
 * The after-turn check: the fingerprints of the protected files before a turn and after it, and the report of what
 * changed. Git status cannot see .git/hooks or .git/config (the WP-10 checkout guard uses it), so the caller takes the
 * fingerprints itself. Report only: nothing is blocked or reverted.
 */
export function checkTurnForProtectedPaths(
  before: Record<string, string>,
  after: Record<string, string>,
): ProtectedTouchReport {
  return reportProtectedTouches(diffFingerprints(before, after));
}
