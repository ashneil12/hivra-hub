import { driveRelative } from "./pathWithin";

// Where logins live, and the files that hold one (WP-101 fix round 2, item B). A name is not enough: `cat ~/.aws`
// lists a folder full of keys without ever saying "credentials", and `grep -r . ~` reads every file the person has.
// Two questions are answered here, both on the real words a command runs with (shellWords.ts):
// - does a word name a credential place or a credential file, judged by any segment of its path and by its file name;
// - does a read that walks folders start somewhere too broad to be a project, or outside the chat's own folder.
// Both lean to holding: a held read costs one tap, a read of the person's keys cannot be taken back.

/** Folders that hold logins: any path through one is a credential place, in any position. */
const PLACES: readonly (readonly string[])[] = [
  [".aws"],
  [".kube"],
  [".ssh"],
  // Agent CLIs keep their own logins: Codex (auth.json), Gemini (oauth_creds.json), OpenCode's auth store (review H2).
  [".codex"],
  [".gemini"],
  [".local", "share", "opencode"],
  // Tool logins: wrangler (Cloudflare), rclone, sops age keys, stripe, doctl, glab and the Hivra config folder (review H2).
  [".wrangler"],
  [".config", "wrangler"],
  [".config", "rclone"],
  [".config", "sops"],
  [".config", "stripe"],
  [".config", "doctl"],
  [".config", "glab-cli"],
  [".config", "hub"],
  [".gnupg"],
  [".docker"],
  [".azure"],
  [".password-store"],
  [".mozilla"],
  [".pki"],
  [".npm"],
  [".terraform.d"],
  [".hermes"],
  // Round 4, item 1: the other agent CLIs' stores (pi, omp, Cursor, Grok, OpenCode's config), and the tool logins
  // (Fly, Railway, ngrok v2, Maven's settings) that a read could reach.
  [".pi"],
  [".omp"],
  [".cursor"],
  [".grok"],
  [".config", "opencode"],
  [".fly"],
  [".railway"],
  [".ngrok2"],
  [".m2"],
  [".zsh_sessions"],
  [".git"],
  ["etc", "shadow"],
  ["etc", "gshadow"],
  ["etc", "passwd"],
  // The password file on a Mac (and the BSDs); `etc/passwd` there lists no hashes.
  ["etc", "master.passwd"],
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "hivra"],
  [".config", "hermes"],
  // Round 2: more logins in ~/.config (fish's config, Copilot's apps.json, configstore tokens, ngrok's authtoken, 1Password's
  // CLI config) and the /.vol inode route, by which macOS reaches any file on a disk without its path.
  [".config", "fish", "config.fish"],
  [".config", "github-copilot"],
  [".config", "configstore"],
  [".config", "ngrok"],
  [".config", "op"],
  [".vol"],
  ["library", "keychains"],
  ["library", "application support"],
  ["library", "cookies"],
  ["library", "safari"],
  [".local", "share", "keyrings"],
  // Round 3 (item 2, Windows): the stores a Windows user's agents, GitHub CLI, rclone, npm and the browsers keep their logins in.
  ["appdata", "roaming", "github cli"],
  ["appdata", "roaming", "rclone"],
  ["appdata", "roaming", "npm", "etc"],
  ["appdata", "local", "google", "chrome"],
  ["appdata", "local", "microsoft", "edge"],
  // Round 6, HIGH-1: the macOS stores of a signed-in app (WebKit's storage, HTTP cookies, Group Containers, Messages,
  // Accounts, sandboxed containers) and the Windows browsers' and apps' stores (Firefox logins, Discord, Brave, VS Code).
  ["library", "webkit"],
  ["library", "httpstorages"],
  ["library", "group containers"],
  ["library", "messages"],
  ["library", "accounts"],
  ["library", "containers"],
  ["appdata", "roaming", "mozilla"],
  ["appdata", "roaming", "discord"],
  ["appdata", "local", "bravesoftware"],
  ["appdata", "roaming", "code"],
];

/** Files whose whole name is a login store, whatever extension they carry. */
const NAMES = new Set([
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
  // Yarn's registry tokens, and fish's history (it records commands typed with secrets in them) (review H2).
  ".yarnrc.yml",
  ".yarnrc",
  "fish_history",
  // Chrome's and Edge's saved passwords file on Windows (its folder is held above).
  "login data",
  // Round 4, items 2 and 3: a dev secret file, and history stores that hold typed secrets.
  ".dev.vars",
  ".sentryclirc",
  ".mysql_history",
  ".node_repl_history",
]);

/** A name that starts this way is a login store, whatever follows (`id_rsa.pub`, `terraform.tfstate.backup`). */
const PREFIXES: readonly string[] = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "service-account", "terraform.tfstate", "kubeconfig"];

/** A name that starts with one of these words is a login store unless it is a source file (`tokenizer.ts`). */
const WORD_PREFIXES: readonly string[] = ["api_key", "apikey", "api-key", "token"];

/** Words that, as a whole file name or folder name, mean a login store. */
const STEMS = new Set(["secret", "secrets", "credential", "credentials", "token", "tokens", "password", "passwords", "passwd"]);

/** An extension that is a key, a certificate or a login store whatever the name before it. */
const KEY_EXTENSIONS = new Set(["key", "pem", "p12", "pfx", "jks", "keystore", "tfvars"]);

/**
 * Extensions a source file has. A name that merely holds a stem word (`secretPatterns.ts`) passes only with one of
 * these and only when the stem is not the whole name (`secrets.yaml`, `credentials.json` still hold).
 */
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "md"]);

/**
 * A Windows 8.3 short name in one segment (`ENV~1`, `CLAUDE~1.MD`, `AUTH~1.JSO`): the real name is hidden from a plain
 * check (round 4, item 5). A git revision such as `HEAD~1` matches too, so git's words are read by `shortNamesRead`.
 */
const SHORT_NAME = /^[^~/\\]{1,8}~\d+(\.[^.]{1,3})?$/;

/** The stem words a file name may hold; with a non-source extension or a dashed name the file is a login store. */
const CONTAINED: readonly string[] = ["secret", "credential", "token", "password", "passwd", "apikey", "api_key", "api-key"];

/** `.env`, `.env.local`, `app.env`: the environment file. `.env.example` and the like are templates, not logins. */
const ENV_FILE = /^(\.env(\..+)?|.+\.env)$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** The last segment of a path, either separator. */
function nameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? "";
}

/** The parts a name is read by: the stem before its extension, and the whole name. */
function parts(name: string): { stem: string; ext: string } {
  const lower = name.toLowerCase();
  const ext = extensionOf(lower);
  return { stem: ext ? lower.slice(0, lower.lastIndexOf(".")) : lower, ext };
}

/**
 * Whether a file name is a login store. A source file that merely holds a word passes (`tokenizer.ts`, `keyboard.ts`,
 * `secretPatterns.json`); a data file named for it does not (`token.txt`, `secrets.yaml`, `private.key`).
 * `known_hosts` passes: it lists public host keys.
 */
export function credentialName(name: string): boolean {
  const file = nameOf(name);
  const lower = file.toLowerCase();
  if (!lower || lower === "known_hosts") return false;
  if (ENV_FILE.test(lower) && !ENV_TEMPLATE.test(lower)) return true;
  // Round 4, item 2: a leading dot is no part of the name (`.secrets` is `secrets`, `.token` is `token`), so the stem tests
  // read the name without it. NAMES still sees the dotted form (`.netrc`).
  const bare = lower.replace(/^\.+/, "");
  const { stem, ext } = parts(bare);
  if (PREFIXES.some((prefix) => bare.startsWith(prefix))) return true;
  // The whole name, before any extension: `secrets`, `credentials.ts`, `token.txt`.
  if (NAMES.has(lower) || NAMES.has(bare) || STEMS.has(stem)) return true;
  if (KEY_EXTENSIONS.has(ext)) return true;
  // Round 4, item 3: a history file names what was typed, secrets included (`.mysql_history`, `<id>.history`). A source
  // file with the word in its name (`chatHistory.ts`) is code, so it passes.
  if (bare.includes("history") && !CODE_EXTENSIONS.has(ext)) return true;
  if (CODE_EXTENSIONS.has(ext)) return false;
  // `apikey.txt`, `api_key.txt`: the word at the start, with anything but a source extension.
  if (WORD_PREFIXES.some((prefix) => stem.startsWith(prefix))) return true;
  // A word joined by a dash (`secret-dump.txt`, `my-token`) is a store. A plain lowercase name that merely holds one
  // (`tokenizer.ts`, `secretPatterns.json`) is the code that reads or writes one.
  const joined = /[_-]/.test(stem);
  if (!joined || !CONTAINED.some((word) => stem.includes(word))) return false;
  return Boolean(ext) || /[*?_-]/.test(stem);
}

// ---- reading a path the way the file system does ----------------------------------------------------------------------
// WP-101 fix round 4, finding 1: a word was judged by its raw text, so `/./Users/…`, `//Users/…`, `/../Users/…`,
// `/users/…` and `/etc/./shadow` were other words than the plain forms, and the kernel opens every one of them. A path
// is folded and resolved here first, and a rule reads the result.

/** Invisible format characters (zero width joiners, direction marks): some file systems ignore them in a name. */
const INVISIBLE = /\p{Cf}/gu;

/**
 * A path as a Mac compares names: compatibility forms folded (a fullwidth `.` is `.`), invisible characters gone, lower
 * case (the Kelvin sign is `k`), one kind of slash, and no space or line break around it (Claude Code's file tools trim
 * a path before they open it). Folding too much only ever holds more.
 */
function fold(path: string): string {
  // Trailing dots and spaces are dropped per segment (round 3, item 2): Windows ignores them, so `.codex.` is `.codex`.
  // A segment that is only dots (`..`) is kept, since it is a climb.
  return path
    .trim()
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/(?<=[^. ])[. ]+$/, ""))
    .join("/");
}

type Resolved = {
  /** The parts that are left once `.`, empty parts and every `..` that has something to cancel are gone. */
  segments: string[];
  /** Whether the path starts at a root (`/…`, `~/…`, `C:/…`) rather than at the working folder. */
  rooted: boolean;
  /** Whether a relative path still climbs out of where it started (leading `..` parts). */
  climbs: boolean;
};

/**
 * A folded path resolved the way the kernel resolves it. A rooted path cannot climb past its root: `/../x` is `/x`. A
 * relative one keeps the climbs it cannot cancel. `~` stands for the home folder as `users/~`, so `~/../x` is a
 * neighbour of the home folder, still under `users`. Either kind of slash and a drive letter are accepted.
 */
function resolvePath(folded: string): Resolved {
  let rest = folded;
  let rooted = rest.startsWith("/");
  if (/^[a-z]:(?=\/|$)/.test(rest)) {
    rooted = true;
    rest = rest.slice(2);
  }
  const tilde = rest === "~" || rest.startsWith("~/");
  const anchored = rooted || tilde;
  // Round 5, H1: a colon is a character of a name (`a:b` is one folder), so only "/" separates levels.
  const parts = rest.split("/");
  if (tilde) parts.shift();
  const segments: string[] = tilde ? ["users", "~"] : [];
  let climbs = false;
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") segments.pop();
      else if (!anchored) {
        segments.push("..");
        climbs = true;
      }
      continue;
    }
    segments.push(part);
  }
  return { segments, rooted: anchored, climbs };
}

/** Whether a stretch of `parts` is one of the places, in order. */
function placeAmong(parts: readonly string[]): boolean {
  return PLACES.some((place) => {
    for (let i = 0; i + place.length <= parts.length; i++) {
      if (place.every((segment, j) => parts[i + j] === segment)) return true;
    }
    return false;
  });
}

/**
 * A process's environment, command line, working folder and root (`/proc/<pid>/environ`, `cwd`, `root`). What `ps e` and
 * `ps -o command` are held for, and the routes (round 2) by which a process's files are read without their path.
 */
const processSecrets = (parts: readonly string[]) =>
  parts.some((part, i) => {
    if (part !== "proc") return false;
    // Round 6, MED-3: a thread's own files (`proc/<pid>/task/<tid>/environ`), and the descriptors, the mapped files and the
    // memory of a process, are read the same way as its environment and command line.
    const at = parts[i + 2] ?? "";
    if (at === "task") return PROCESS_FILES.includes(parts[i + 4] ?? "");
    return PROCESS_FILES.includes(at);
  });

/** The files of a process that hold its secrets or let a read reach its files (`/proc/<pid>/<name>`, round 6). */
const PROCESS_FILES: readonly string[] = ["environ", "cmdline", "cwd", "root", "fd", "map_files", "mem"];

/** Whether these (folded) parts name a credential place or a credential file. */
function credentialSegments(parts: readonly string[]): boolean {
  if (!parts.length) return false;
  if (parts[parts.length - 1] === "known_hosts") return false;
  // A Windows 8.3 short name (`CODEX~1`, `AUTH~1.JSO`) hides the real name from a plain check: held (round 3, item 2).
  if (placeAmong(parts) || processSecrets(parts)) return true;
  // A folder that holds logins (`secrets/`, `.ssh/`) makes every file under it a credential place too.
  if (parts.slice(0, -1).some((part) => STEMS.has(part) || NAMES.has(part))) return true;
  return credentialName(parts[parts.length - 1]);
}

/**
 * Whether a path names a credential place or a credential file, by any segment. The parts are read as written and
 * again once the path is resolved, so a two-part place (`etc/shadow`) cannot be split by a `.` or a `..`, and a name
 * that only a climb leaves behind is still seen. `shortNames` is off only for a git revision (`HEAD~1`), which is not a
 * file name (see shortNamesRead).
 */
export function credentialPath(path: string, shortNames = true, folder?: string): boolean {
  const folded = fold(path);
  const written = folded.split("/").filter(Boolean);
  if (!written.length) return false;
  // Round 5, H1: a colon splits a name only for the names and places it may hold (`HEAD:.env`), never for a climb.
  const named = written.flatMap((part) => part.split(":")).filter(Boolean);
  // A Windows 8.3 short name hides the real name: held (round 3, item 2; round 4, item 5). Round 13: only below the
  // chat folder. A temp folder is itself `RUNNER~1`, and that name is not a file the chat named.
  if (shortNames && shortNameHeld(named, path, folder)) return true;
  return credentialSegments(named) || credentialSegments(resolvePath(folded).segments);
}

/**
 * Whether a colon remains after a verbatim prefix and one drive colon (round 5 H1, round 13). `a:b/../../.zshrc` and
 * `C:\proj\a:b\..\.zshrc` still have a colon. `\\?\C:\x\a.txt` does not. A UNC path has no drive colon to skip.
 */
function colonPastDrive(path: string): boolean {
  let rest = path;
  let unc = false;
  if (/^\\\\\?\\unc\\/i.test(rest)) {
    rest = rest.slice(8);
    unc = true;
  } else if (/^\\\\\?\\/.test(rest) || /^\\\\\.\\/.test(rest)) {
    rest = rest.slice(4);
  } else if (rest.startsWith("\\\\")) {
    unc = true;
  }
  if (unc) return rest.includes(":");
  return rest.replace(/^[a-zA-Z]:(?=[\\/]|$)/, "").includes(":");
}

/** A verbatim `\\?\UNC\`, `\\?\` or `\\.\` prefix, so a drive colon in it is not part of the name (round 13). */
function stripVerbatim(text: string): string {
  if (/^\\\\\?\\unc\\/i.test(text)) return `\\\\${text.slice(8)}`;
  if (/^\\\\\?\\/.test(text) || /^\\\\\.\\/.test(text)) return text.slice(4);
  return text;
}

/** The drive letter after a verbatim prefix, or "" for a UNC or POSIX path. */
function driveOf(text: string): string {
  const match = /^([a-z]):/i.exec(fold(stripVerbatim(text)));
  return match ? match[1].toLowerCase() : "";
}

/**
 * The segments of `path` strictly below `folder`, when `path` is that folder or inside it (same drive). Null when it is
 * not inside, so the caller keeps the whole-path check. A verbatim prefix is stripped on both sides first.
 */
function belowFolder(path: string, folder: string): string[] | null {
  if (driveOf(path) !== driveOf(folder)) return null;
  const pathSegs = resolvePath(fold(stripVerbatim(path))).segments;
  const folderSegs = resolvePath(fold(stripVerbatim(folder))).segments;
  if (!folderSegs.length || !startsWith(pathSegs, folderSegs)) return null;
  return pathSegs.slice(folderSegs.length);
}

/** Whether a short name is held: only below `folder` when the path is inside it, otherwise in any segment. */
function shortNameHeld(named: readonly string[], path: string, folder?: string): boolean {
  if (typeof folder === "string" && folder) {
    const below = belowFolder(path, folder);
    if (below) return below.some((part) => SHORT_NAME.test(part));
  }
  return named.some((part) => SHORT_NAME.test(part));
}

/**
 * Whether a word's Windows short names are read. Git's words are revisions (`HEAD~1`, `main~2`) unless `--no-index` makes
 * git compare two files on disk, and a word with a slash is a path in any command. Round 4, item 5.
 */
export function shortNamesRead(command: string, args: readonly string[], word: string): boolean {
  return !(command === "git" && !args.includes("--no-index") && !/[/\\]/.test(word));
}

const dotNamed = (part: string) => part.startsWith(".") && part !== "." && part !== "..";

/**
 * Whether a path is outside the chat's own folder and has a dot-named segment anywhere in it (round 4, item 1). This is
 * the structural rule the Rust check uses: a dot-named folder or file is a tool's config or a login, and a read or a
 * search of one is held wherever it is outside the chat. Inside the chat's folder the named lists judge the path. A
 * relative path is placed under the folder first, so `../.pi/x` from inside the chat is held and `./src/.github/x` is
 * not. A relative path with no folder known is left to the timer's own rule (timerOutside), since the approval path
 * always knows the folder; an absolute path with no folder that has a dot-named part is outside.
 */
export function dotOutside(path: string, folder: string | undefined): boolean {
  const folded = fold(path);
  const base = foldedFolder(folder);
  const anchored = folded.startsWith("/") || /^[a-z]:/.test(folded) || folded === "~" || folded.startsWith("~/");
  if (!anchored && !base) return false;
  const absolute = anchored ? folded : `/${(base ?? []).join("/")}/${folded}`;
  const { segments } = resolvePath(absolute);
  if (base && base.length >= MIN_PROJECT_DEPTH && startsWith(segments, base)) return false;
  return segments.some(dotNamed);
}

/** A search's option that names its pattern (`-e`, `-f`, `--regexp`, `--file`, also in a cluster such as `-ie`). */
const PATTERN_OPTION = /^(-[^-]*[ef]|--(regexp|file)(=|$))/;

/**
 * Whether a timer's words are outside: a timer has no chat folder, so a rooted piece, a climb, or a dot-named part is
 * outside it (round 4, item 4). Each piece of a word counts (`--format=%H/%s`, `-C~`, `-f.netrc`), as the Rust timer
 * check counts them (watcher/safe_cmd.rs names_login_or_outside).
 */
export function timerOutside(words: readonly string[]): boolean {
  return words.slice(1).some((word) =>
    pieces(word).some((piece) => {
      const parts = piece.split(/[/\\:]/);
      return /^[~/\\]|^[a-z]:[/\\]/i.test(piece) || parts.some((part) => part === ".." || dotNamed(part));
    }),
  );
}

/** The pieces of a word that can name a path: the word, its bare form, and an `--opt=value` value. */
function pieces(word: string): string[] {
  const out = [word];
  const bare = word.replace(/^-+/, "");
  if (bare !== word) out.push(bare);
  if (bare.includes("=")) out.push(bare.slice(bare.indexOf("=") + 1));
  // A short option's value glued on with no space or `=` (`grep -f/Users/me/.zshrc`): the path starts at its first slash.
  if (word.startsWith("-") && word.includes("/")) out.push(word.slice(word.indexOf("/")));
  // Round 4, item 4: and the value after the option's letter, with no slash at all (`grep -f.netrc x`).
  if (/^-[^-]/.test(word) && word.length > 2) out.push(word.slice(2));
  return out;
}

/** Whether a word looks like a pattern rather than a path: a plain word with no slash, dot or tilde. */
function patternLike(word: string): boolean {
  return !/[./~\\]/.test(word) && !word.startsWith("-");
}

/** `*`, `?` or `[`: a filename glob. A content pattern may hold one too, and that is held rather than read. */
const GLOB = /[*?\[]/;

/** Shell startup files. A copy under the home folder is that person's shell, not a file in the chat. */
const SHELL_RC = new Set([
  ".zshrc",
  ".bashrc",
  ".profile",
  ".bash_profile",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".bash_login",
  ".bash_logout",
  ".zlogout",
  ".kshrc",
  ".cshrc",
  ".tcshrc",
  ".login",
  ".logout",
]);

/** A folder shallower than this (/, /Users, /Users/someone) is too broad to count as a chat's own. */
const MIN_PROJECT_DEPTH = 3;

/**
 * Whether absolute parts sit inside a person's home folder, however the path got there: `/Users/…` and `/home/…` in
 * any case, the Mac's own other names for them (`/System/Volumes/Data/Users/…`, `/Volumes/<disk>/Users/…`, a
 * `/private` prefix), Linux's (`/proc/<pid>/root/…`), and root's home (`/var/root`, `/root`).
 */
function underHome(parts: readonly string[]): boolean {
  let rest = parts;
  for (;;) {
    // macOS's own prefixes for a path reached another way: /.nofollow/ and /.resolve/<n>/ (round 3, item 3).
    if (rest[0] === ".nofollow") rest = rest.slice(1);
    else if (rest[0] === ".resolve" && /^\d+$/.test(rest[1] ?? "")) rest = rest.slice(2);
    else if (rest[0] === "system" && rest[1] === "volumes" && rest[2] === "data") rest = rest.slice(3);
    else if (rest[0] === "volumes" && rest.length > 1) rest = rest.slice(2);
    else if (rest[0] === "private") rest = rest.slice(1);
    else if (rest[0] === "proc" && rest[2] === "root") rest = rest.slice(3);
    else break;
  }
  if ((rest[0] === "users" || rest[0] === "home") && rest.length > 1) return true;
  return rest[0] === "root" || (rest[0] === "var" && rest[1] === "root");
}

const preferencesIn = (parts: readonly string[]) => parts.some((part, i) => part === "library" && parts[i + 1] === "preferences");

/** Fish's startup files and its conf.d folder, which runs every file in it at each shell start (round 3, item 3). */
const fishStartup = (parts: readonly string[]) =>
  parts.some((part, i) => part === ".config" && parts[i + 1] === "fish" && (parts[i + 2] === "conf.d" || parts[i + 2] === "config.fish"));

/** A startup file's name, or a backup, a local copy or an editor copy of one (`.zshrc.bak`, `.zshrc.local`, `.zshrc~`). */
function shellRcName(name: string): boolean {
  if (SHELL_RC.has(name)) return true;
  for (const rc of SHELL_RC) if (name.startsWith(rc) && /^[._~-]/.test(name.slice(rc.length))) return true;
  return false;
}

/** Whether absolute parts are a shell startup file or a preferences file under a home folder. */
function homeShellParts(parts: readonly string[]): boolean {
  return underHome(parts) && (shellRcName(parts[parts.length - 1] ?? "") || preferencesIn(parts) || fishStartup(parts));
}

/** The chat's folder as folded absolute parts, or null when there is none. */
export function foldedFolder(folder: string | undefined): string[] | null {
  if (typeof folder !== "string" || !folder) return null;
  const resolved = resolvePath(fold(folder));
  return resolved.rooted ? resolved.segments : null;
}

/**
 * Whether a word is a shell startup file or a preferences file under a home folder. The word is resolved first (`.`,
 * `..`, repeated slashes, any case, the Mac's other names for a home folder), so `/./Users/me/.zshrc` and
 * `/users/me/.zshrc` are the file `/Users/me/.zshrc` is. A name inside the chat's own folder (deep enough to be a
 * project, so not `/Users/me` itself) is the chat's file, absolute or relative. A relative name that climbs out of the
 * folder is resolved against it (`../../.zshrc` from `/Users/me/work/x` is the home file); with no folder known, a
 * climb that ends at a startup file is held. A backup or local copy of a startup file counts as one. History files
 * are already credential names.
 */
function homeShellFile(word: string, folder?: string): boolean {
  const { segments, rooted, climbs } = resolvePath(fold(word));
  const base = foldedFolder(folder);
  // Inside a folder deep enough to be a project, a file named like a startup file is the project's own. A read tool
  // always names its file absolutely, so this holds for an absolute path too.
  const ownFile = (parts: readonly string[]) => base !== null && base.length >= MIN_PROJECT_DEPTH && startsWith(parts, base);
  if (rooted) return !ownFile(segments) && homeShellParts(segments);
  if (!base) return climbs && (shellRcName(segments[segments.length - 1] ?? "") || preferencesIn(segments));
  const up = segments.findIndex((part) => part !== "..");
  const lead = up < 0 ? segments.length : up;
  const full = [...base.slice(0, Math.max(0, base.length - lead)), ...segments.slice(lead)];
  return !ownFile(full) && homeShellParts(full);
}

/**
 * The credential place or file a command names, or null. A command that searches (`grep`, `rg`, `ag`, `fd`) reads its
 * first bare word as a pattern, so a search for the word `token` is a search, not a file, and passes. A word that
 * contains a glob does not: `rg -g '*netrc*'` names files, and ripgrep matches a leading dot, so the command is held
 * whether or not the glob itself is a credential name. The same holds for `find -name`, `-iname` and `-path`. A glob
 * glued on with `=` (`--include=*netrc*`, `--glob=*history*`) is the same word, and so is a path glued to a short option
 * (`grep -f/Users/me/.zshrc`). `folder` is the chat's folder, which a relative path that climbs out of it is resolved
 * against.
 */
export function credentialInWords(words: readonly string[], folder?: string): string | null {
  const head = words[0]?.replace(/^-+/, "") ?? "";
  const searches = head === "grep" || head === "rg" || head === "ag" || head === "fd" || head === "find";
  // Only the first bare word after the command is the pattern; a later bare word is a file (`grep '' secrets` names
  // the file secrets, review lows). A -e or -f option names the pattern itself (round 4), so no bare word is one then.
  let patternSeen = searches && head !== "find" && words.slice(1).some((word) => PATTERN_OPTION.test(word));
  for (const [index, word] of words.entries()) {
    if (searches && pieces(word).some((piece) => GLOB.test(piece))) return word;
    if (searches && head !== "find" && index > 0 && !patternSeen && patternLike(word)) {
      patternSeen = true;
      continue;
    }
    for (const piece of pieces(word)) {
      if (!piece) continue;
      if (homeShellFile(piece, folder) || credentialPath(piece, shortNamesRead(words[0], words.slice(1), piece), folder)) return piece;
      if (dotOutside(piece, folder)) return piece;
    }
  }
  return null;
}

/**
 * The first of a read tool's own file paths (a Read call's `file_path`) that is a credential or a home shell file, or
 * null. A path is judged whole, as given, which the red list's reading of prose cannot do: it splits a path at a space,
 * so `Library/Application Support/…` was never seen as one place, and it does not know a startup file at all. A paths
 * field that is not a list, a path that is not text and a path with a NUL in it (the kernel stops reading a name there)
 * are named too: they can't be read, so they are held. `folder` is the chat's folder, for a relative path that climbs.
 */
export function credentialInPaths(paths: unknown, folder?: string): string | null {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths)) return "(a list of files it can't read)";
  for (const path of paths) {
    if (typeof path !== "string") return "(a file name that isn't text)";
    // Round 5, H1: a colon after the drive is not a Windows path; it can only be a name that climbs out, so it is held.
    // Round 13: a verbatim `\\?\C:\` prefix's colon is the drive, as in the stream check. A colon still in the name holds.
    if (colonPastDrive(path)) return path;
    if (path.includes("\0") || homeShellFile(path, folder) || credentialPath(path, true, folder) || dotOutside(path, folder)) return path;
  }
  return null;
}

/** Whether prose names a credential file: only path-shaped words count, so ordinary text is left alone. */
export function credentialInText(text: string): boolean {
  for (const raw of text.split(/[^a-z0-9_.~/-]+/)) {
    const word = raw.replace(/^[.~/-]+$/, "");
    if (!word) continue;
    if (!word.includes("/") && !word.includes(".") && !word.includes("~")) continue;
    // A git revision in prose (`HEAD~1`) is not a short file name; a command's words are judged with git's own rule.
    const revision = /^[^/\\:]*~\d+$/.test(word);
    if (credentialPath(word, !revision)) return true;
  }
  return false;
}

// ---- reads that walk folders --------------------------------------------------------------------------------------

/**
 * Long options, from any of the search tools, that turn the ignore rules off or show hidden files: ripgrep's
 * `--no-ignore*`, `--hidden`, `--unrestricted`, fd's `--no-global-ignore-file`, ag's `--skip-vcs-ignores`, `--all-types`
 * and `--all-text`. A name matches when it starts with one (`--no-ignore-vcs`) or abbreviates one from four characters
 * (`--hid`, `--skip-vcs`): some of these programs take an abbreviation, and holding one too many costs a tap.
 */
const IGNORE_OFF_LONG: readonly string[] = ["--hidden", "--unrestricted", "--no-ignore", "--no-global-ignore", "--skip-vcs-ignores", "--all-types", "--all-text"];

/**
 * Whether an argument turns a search's ignore rules off or shows hidden files. A long name is matched above. A short
 * cluster is: one that carries `u` in any case (`-u`, `-uu`, `-uuu`, `-nu`, `-U`) for every tool, and per tool the
 * letters that mean the same there. fd: `-H` (hidden) and `-I` (no ignore files), capital only, since `-h` is help and
 * `-i` is ignore-case. ag: `-a` and `-t` search every file an ignore rule skips. ripgrep: `-.` is `--hidden`. For
 * ripgrep and grep `-H` is `--with-filename`, which is harmless, so the letter is only read for the tool it means
 * something in. A prefix is one way only, so `--no-heading` and `--no-filename` are not `--no-ignore`.
 */
function unrestricted(head: string, arg: string): boolean {
  const name = arg.split("=", 1)[0];
  if (name.startsWith("--")) {
    const long = name.toLowerCase();
    return IGNORE_OFF_LONG.some((option) => long.startsWith(option) || (long.length >= 4 && option.startsWith(long)));
  }
  if (!/^-[^-]/.test(name)) return false;
  const cluster = name.slice(1);
  if (cluster.toLowerCase().includes("u")) return true;
  switch (head) {
    case "rg":
      return cluster.includes(".");
    case "fd":
      return /[HI]/.test(cluster);
    case "ag":
      return /[at]/.test(cluster);
    default:
      return false;
  }
}

/**
 * Whether this command turns its ignore rules off. `find`'s short options include `-prune` and `-user`, and a `u` in
 * those is not this, so `find` only matches the long names.
 */
function ignoreOff(head: string, args: readonly string[]): boolean {
  if (head === "find") {
    return args.some((arg) => {
      const name = arg.split("=", 1)[0].toLowerCase();
      return name === "--hidden" || name.startsWith("--no-ignore");
    });
  }
  return (head === "rg" || head === "ag" || head === "grep" || head === "fd") && args.some((arg) => unrestricted(head, arg));
}

/** Whether `grep` walks the tree. It has no ignore list, so any of these is held wherever it starts. */
function grepRecurses(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg.split("=", 1)[0];
    if ((/^-[^-]/.test(name) && /[rR]/.test(name.slice(1))) || name === "--recursive" || name === "--dereference-recursive") return true;
    if (name === "-d" || name === "--directories") {
      const mode = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (mode === "recurse") return true;
    }
  }
  return false;
}

/**
 * Whether a command walks folders rather than reading the files it is named. `git diff` is one: given two paths with one
 * outside the repository (or any two, under `--no-index`) it compares them on disk, a folder against a folder prints
 * every file in both, and no flag says so. Its revisions and pathspecs are relative words and stay inside the folder.
 */
function walksFolders(head: string, args: readonly string[]): boolean {
  switch (head) {
    case "git":
      return args[0] === "diff";
    case "rg":
    case "ag":
    case "find":
    case "fd":
    case "tree":
    case "du":
      return true;
    case "grep":
      return args.some((arg) => (/^-[^-]/.test(arg) && /[rR]/.test(arg.slice(1))) || arg === "--recursive" || arg === "--dereference-recursive");
    case "ls":
      return args.some((arg) => (/^-[^-]/.test(arg) && arg.slice(1).includes("R")) || arg === "--recursive");
    default:
      return false;
  }
}

/** A path with ".", ".." and repeated slashes resolved; null when it climbs past /. */
function normalise(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

const startsWith = (parts: readonly string[], prefix: readonly string[]) =>
  prefix.length <= parts.length && prefix.every((part, i) => parts[i] === part);

/** A drive path, `C:\` or `C:/`. A backslash is a separator only for one of these, or a UNC share (round 8). */
const DRIVE_ABS = /^[a-z]:[\\/]/i;

/** Whether a chat folder is a Windows path: a drive or a UNC share (`\\server`). `//` on a Mac stays a name. */
function windowsFolder(folder: string | undefined): boolean {
  return !!folder && (DRIVE_ABS.test(folder) || folder.startsWith("\\\\"));
}

/**
 * The chat's folder as parts; null when there is none or it is too shallow to be a chat's own.
 * A Windows folder (round 12) keeps its drive and reads `\` as a separator, compared in lower case, so `c:\` and `C:\`
 * are one folder. A Mac or Linux folder is unchanged: only a leading `/` counts, and a backslash is a letter.
 */
function folderParts(folder: string | undefined): string[] | null {
  if (!folder) return null;
  const windows = windowsFolder(folder);
  const root = (windows ? folder.replace(/\\/g, "/") : folder).replace(/\/+$/, "");
  if (!root || (!windows && !root.startsWith("/"))) return null;
  const parts = normalise(windows ? root.toLowerCase() : root);
  return parts && parts.length >= 3 ? parts : null;
}

/** Where a walk starts: under the chat's folder for an approval (`base`), or as written for a timer (no folder). */
function startOf(arg: string, base: readonly string[] | null): { segments: string[]; rooted: boolean } {
  const folded = fold(arg);
  const anchored = folded.startsWith("/") || folded === "~" || folded.startsWith("~/") || /^[a-z]:/.test(folded);
  const resolved = resolvePath(base && !anchored ? `/${base.join("/")}/${folded}` : folded);
  return { segments: resolved.segments, rooted: resolved.rooted };
}

/**
 * Whether a chat's folder can hold a walk: deep enough to be a project, and not a credential place, inside one, or a
 * parent of one (round 6, MED-2). A timer in a folder that can't hold a walk takes no bare file name either (round 7, LOW).
 */
export function projectFolder(folder: string | undefined): boolean {
  const base = foldedFolder(folder);
  return base !== null && base.length >= MIN_PROJECT_DEPTH && !startsAtPlaceParent({ segments: base, rooted: true }) && !credentialSegments(base);
}

/**
 * Whether a walk's start is at or above a credential place: its last segments are the first segments of a place, so the
 * place lies below it (`Library`, `AppData/Roaming`, `/etc`). The filesystem root (rooted, no segments) is above all.
 */
function startsAtPlaceParent({ segments, rooted }: { segments: string[]; rooted: boolean }): boolean {
  if (rooted && !segments.length) return true;
  for (let k = 1; k <= segments.length; k++) {
    const tail = segments.slice(segments.length - k);
    if (PLACES.some((place) => place.length > k && tail.every((part, i) => part === place[i]))) return true;
  }
  return false;
}

/** A brace list with a slash or a climb inside it: `{/etc,src}`, `{../..,src}`, `src/{a,../../etc}` (round 3, item 5). */
const BRACE_OUTSIDE = /\{[^}]*(\/|\.\.)[^}]*\}/;

/**
 * Whether a folder walk waits for Ash. A walk from the home folder, a parent of the chat's folder, `/`, a credential
 * folder, `..` or anywhere else outside the folder is held. A search that turns the ignore rules off (`-u`, `-uu`,
 * `-uuu`, `--no-ignore*`, `--hidden`) is held even inside the chat's folder, because it reads what a project keeps out
 * of git. Recursive `grep` (`-r`, `-R`, `--recursive`, `-d recurse`) has no ignore list, so it is held wherever it
 * starts. When no folder is known, any other walk still has to start at a relative place: the shell's working folder
 * is the chat's own, but nothing absolute can be shown to be inside it.
 */
export function walkHeld(words: readonly string[], folder: string | undefined, timer = false): boolean {
  if (!words.length) return true;
  const head = words[0];
  const args = words.slice(1);
  if (ignoreOff(head, args) || (head === "grep" && grepRecurses(args))) return true;
  // A brace list naming a folder outside the chat's own (`{/etc,src}/*`, `{../..,src}/**`) is held, whatever the command:
  // zsh expands it before the command runs (round 3, item 5).
  if (args.some((arg) => BRACE_OUTSIDE.test(arg))) return true;
  if (!walksFolders(head, args)) return false;
  // Round 5, H2: a walk from a chat whose folder is home or shallower (or none) is not known to stay in a project, so an
  // approval holds it. A timer has no chat folder; its words are judged alone.
  // Round 6, MED-2: a timer's check runs in the chat's folder too, so the same gate holds it. A folder at or inside a
  // credential place is held as well: its walk reaches the place with no path at all.
  if (!projectFolder(folder)) return true;
  const base = foldedFolder(folder);
  const root = folderParts(folder);
  const windows = windowsFolder(folder);
  // A search's pattern is not a path: its first bare word, unless a -e or -f option names the pattern (round 4; the
  // same rule credentialInWords and the Rust timer check read). A Grep or Glob call's paths are walked from, so
  // searchStartsOutside passes them under `find`, which has no pattern.
  const searching = head === "grep" || head === "rg" || head === "ag" || head === "fd";
  let patternSeen = searching && args.some((arg) => PATTERN_OPTION.test(arg));
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (searching && !patternSeen && patternLike(arg)) {
      patternSeen = true;
      continue;
    }
    // Home-relative words and anything through a credential place are outside the chat's folder however they resolve.
    if (arg.startsWith("~") || credentialPath(arg, shortNamesRead(head, args, arg), folder) || dotOutside(arg, folder)) return true;
    // Round 5, H2: a walk that starts at a parent of a credential place (Library, AppData, /etc, /) reaches the place.
    if (startsAtPlaceParent(startOf(arg, timer ? null : base))) return true;
    // A drive-relative start (`D:Users`, `D:notes.txt`) names that drive's current folder, not a path under the chat.
    // Another drive is outside. The chat's own drive is unknown, so a word on it is held too.
    if (windows && driveRelative(arg)) return true;
    if (!root) {
      // No folder known: only a relative place below the working folder can be shown to stay inside it.
      // A drive or UNC path is absolute too (round 12): it used to be read as a relative name, so a search of
      // `C:\...` from a chat on the same drive was allowed.
      if (arg.startsWith("/") || DRIVE_ABS.test(arg) || arg.startsWith("\\\\")) return true;
      const relText = windows ? arg.replace(/\\/g, "/") : arg;
      const rel = normalise(`/${relText}`);
      if (!rel || relText.split("/").includes("..")) return true;
      continue;
    }
    // Round 12: a drive or UNC start is anchored, not joined under the chat as a relative name. `\` separates only
    // for a Windows chat folder, and the parts are lower case so `c:\` inside `C:\` stays inside.
    const piece = windows ? arg.replace(/\\/g, "/").toLowerCase() : arg;
    const anchored = piece.startsWith("/") || (windows && (DRIVE_ABS.test(arg) || arg.startsWith("\\\\")));
    const place = normalise(anchored ? piece : `/${[...root, piece].join("/")}`);
    if (!place || place.length < 3) return true;
    if (!startsWith(place, root)) return true;
  }
  return false;
}

/**
 * Whether a word of a command names a place outside the chat's own folder (review round 6, HIGH-1): a rooted path, a home
 * word, a drive or a UNC path, or a relative one that climbs out of the folder. Every piece of the word counts, so
 * `--file=/x` and `-f/x` are held as `/x`. A word that stays inside is read as it is written, as an approval's words
 * always were. With no folder known, a rooted or climbing word is outside, since nothing shows it is inside.
 */
export function wordOutside(word: string, folder: string | undefined): boolean {
  const base = foldedFolder(folder);
  const windows = windowsFolder(folder);
  return pieces(word).some((piece) => {
    const folded = fold(piece);
    if (!folded) return false;
    // A drive-relative word (`D:notes.txt`) opens that drive's current folder. On another drive that is outside the
    // chat. On the chat's own drive the current folder is unknown, so the word is held too.
    if (windows && driveRelative(folded)) return true;
    const anchored = folded.startsWith("/") || folded === "~" || folded.startsWith("~/") || /^[a-z]:(?=\/|$)/.test(folded);
    if (!base) return anchored || folded.split("/").includes("..");
    const resolved = resolvePath(anchored ? folded : `/${base.join("/")}/${folded}`);
    return !startsWith(resolved.segments, base);
  });
}
