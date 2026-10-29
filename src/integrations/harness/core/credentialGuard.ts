// r65 (PM's r63 #13): the Hivra Lead tried `security find-generic-password`. No Mono or worker reads a saved password,
// key or token: the keychain, the agents' own sign-in files, or a .env outside the project it works in. This is enforced
// in code for every harness (registry.ts, claude.ts) and as Claude Code deny rules at launch, never as a rule in a soul.
// A blocked call tells the agent to ask Ash for the thing instead of retrying, which shows as a provide card.

/** What the agent reads back when a call is blocked. Raising the ask is what shows Ash the provide card. */
export const CREDENTIAL_BLOCK_MESSAGE =
  "Blocked by MonoCode: that reads a saved password, key or token, which agents never do. Don't retry it or look for it another way. If you need it, ask Ash on its own line: \"Needs Ash (provide): <what you need and why>\".";

/** Claude Code permission rules, passed as --disallowedTools; deny rules hold even in bypass mode. */
export const CREDENTIAL_DENY_RULES: readonly string[] = [
  "Bash(security find-generic-password:*)",
  "Bash(security find-internet-password:*)",
  "Bash(security find-certificate:*)",
  "Bash(security find-identity:*)",
  "Bash(security find-key:*)",
  "Bash(security dump-keychain:*)",
  "Bash(security export:*)",
  "Bash(security unlock-keychain:*)",
  "Read(~/.claude/.credentials.json)",
  "Read(~/.claude.json)",
  "Read(~/.codex/auth.json)",
  "Read(~/.aws/credentials)",
  "Read(~/.netrc)",
  "Read(~/.ssh/**)",
  "Read(~/.config/gh/hosts.yml)",
  "Read(~/.local/share/claude-gpt/**)",
  "Read(~/Library/Keychains/**)",
  "Read(~/.env*)",
];

/**
 * r67 (Alfred's r66 rechecks, 29 Oct): frank answered "what did I say about models" by running sqlite3 on the app's own
 * database, and other Monos read sessions, delegations and transcripts out of monocode.db by hand. No agent reads the
 * hub's database or the window's storage directly: it is Ash's whole history, half-written while the app runs, and the
 * MonoCode tools already give the parts an agent may see. Enforced like the keychain rule, in code for every harness.
 */
export const HUB_DB_BLOCK_MESSAGE =
  "Blocked by MonoCode: agents never read the hub's database or the window's storage directly. Don't retry it or look for it another way. Use the MonoCode tools: task_status for work and workers, room_read for a room's messages, and your own memory files for what Ash said. If none of them has it, say so plainly.";

/** The same, as Claude Code deny rules for every hub chat. */
export const HUB_DB_DENY_RULES: readonly string[] = [
  "Bash(*com.ash.monocode-hub*.db*)",
  "Bash(*com.ash.monocode-hub*sqlite*)",
  "Read(~/Library/Application Support/com.ash.monocode-hub*/*.db*)",
  "Read(~/Library/WebKit/com.ash.monocode-hub*/**)",
];

/** The app's data folder (the daily app or any dev slot) or its WebKit storage, then a database file in it. */
const HUB_DB = /(?:Application Support\/com\.ash\.monocode-hub[^/\s"']*\/[^\s"';|&)]*\.(?:db|sqlite3?)(?:-wal|-shm)?\b|\/WebKit\/com\.ash\.monocode-hub)/i;
/** A bare monocode.db read by a database tool from wherever the shell happens to be. */
const HUB_DB_TOOL = /(^|[\s;&|(`$])(?:\/usr\/bin\/)?sqlite3\b[^;&|]*\bmonocode\.db\b/i;

const KEYCHAIN = /(^|[\s;&|(`$])(\/usr\/bin\/)?security\s+(find-[\w-]+|dump-keychain|export|unlock-keychain)\b/;
const SECRET_FILES = [
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.claude\/\.credentials/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.claude\.json\b/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.codex\/auth\.json/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.aws\/credentials/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.netrc\b/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.ssh\/(id_|.*key)/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.config\/gh\/hosts\.yml/,
  /(~|\$HOME|\/Users\/[^/\s]+)\/\.local\/share\/claude-gpt\//,
  /\/Library\/Keychains\//,
];
const ENV_PATH = /(?:^|[\s"'=:(])((?:~|\$HOME|\/|\.\.)[^\s"';|&)]*\/\.env(?:\.[\w.-]+)?)(?=$|[\s"';|&)])/g;

function expandHome(path: string, home?: string): string {
  if (!home) return path;
  return path.replace(/^(~|\$HOME)(?=\/)/, home);
}

function insideProject(path: string, cwd?: string, home?: string): boolean {
  if (!cwd) return false;
  const root = expandHome(cwd, home).replace(/\/+$/, "");
  return expandHome(path, home).startsWith(`${root}/`);
}

/** The reason a command or file read is blocked, or undefined when it is fine. Relative .env paths stay in the project. */
export function credentialBlock(
  call: { tool?: string; command?: string; paths?: readonly string[] } | undefined,
  cwd?: string,
  home?: string,
): string | undefined {
  if (!call) return undefined;
  home ??= cwd?.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  const texts = [call.command ?? "", ...(call.paths ?? [])].filter(Boolean);
  for (const text of texts) {
    if (KEYCHAIN.test(text)) return CREDENTIAL_BLOCK_MESSAGE;
    if (SECRET_FILES.some((re) => re.test(text))) return CREDENTIAL_BLOCK_MESSAGE;
    if (HUB_DB.test(text) || HUB_DB_TOOL.test(text)) return HUB_DB_BLOCK_MESSAGE;
    const padded = ` ${text}`;
    for (const match of padded.matchAll(ENV_PATH)) {
      if (!insideProject(match[1], cwd, home)) return CREDENTIAL_BLOCK_MESSAGE;
    }
  }
  return undefined;
}
