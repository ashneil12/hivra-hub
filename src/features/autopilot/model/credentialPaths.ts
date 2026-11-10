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
  const { stem, ext } = parts(lower);
  if (PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // The whole name, before any extension: `secrets`, `credentials.ts`, `token.txt`.
  if (NAMES.has(lower) || STEMS.has(stem)) return true;
  if (KEY_EXTENSIONS.has(ext)) return true;
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
  return path.trim().normalize("NFKC").replace(INVISIBLE, "").toLowerCase().replace(/\\/g, "/");
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
  const parts = rest.split(/[/:]/);
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
  parts.some((part, i) => part === "proc" && ["environ", "cmdline", "cwd", "root"].includes(parts[i + 2] ?? ""));

/** Whether these (folded) parts name a credential place or a credential file. */
function credentialSegments(parts: readonly string[]): boolean {
  if (!parts.length) return false;
  if (parts[parts.length - 1] === "known_hosts") return false;
  if (placeAmong(parts) || processSecrets(parts)) return true;
  // A folder that holds logins (`secrets/`, `.ssh/`) makes every file under it a credential place too.
  if (parts.slice(0, -1).some((part) => STEMS.has(part) || NAMES.has(part))) return true;
  return credentialName(parts[parts.length - 1]);
}

/**
 * Whether a path names a credential place or a credential file, by any segment. The parts are read as written and
 * again once the path is resolved, so a two-part place (`etc/shadow`) cannot be split by a `.` or a `..`, and a name
 * that only a climb leaves behind is still seen.
 */
export function credentialPath(path: string): boolean {
  const folded = fold(path);
  const written = folded.split(/[/:]/).filter(Boolean);
  if (!written.length) return false;
  return credentialSegments(written) || credentialSegments(resolvePath(folded).segments);
}

/** The pieces of a word that can name a path: the word, its bare form, and an `--opt=value` value. */
function pieces(word: string): string[] {
  const out = [word];
  const bare = word.replace(/^-+/, "");
  if (bare !== word) out.push(bare);
  if (bare.includes("=")) out.push(bare.slice(bare.indexOf("=") + 1));
  // A short option's value glued on with no space or `=` (`grep -f/Users/me/.zshrc`): the path starts at its first slash.
  if (word.startsWith("-") && word.includes("/")) out.push(word.slice(word.indexOf("/")));
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
    if (rest[0] === "system" && rest[1] === "volumes" && rest[2] === "data") rest = rest.slice(3);
    else if (rest[0] === "volumes" && rest.length > 1) rest = rest.slice(2);
    else if (rest[0] === "private") rest = rest.slice(1);
    else if (rest[0] === "proc" && rest[2] === "root") rest = rest.slice(3);
    else break;
  }
  if ((rest[0] === "users" || rest[0] === "home") && rest.length > 1) return true;
  return rest[0] === "root" || (rest[0] === "var" && rest[1] === "root");
}

const preferencesIn = (parts: readonly string[]) => parts.some((part, i) => part === "library" && parts[i + 1] === "preferences");

/** A startup file's name, or a backup, a local copy or an editor copy of one (`.zshrc.bak`, `.zshrc.local`, `.zshrc~`). */
function shellRcName(name: string): boolean {
  if (SHELL_RC.has(name)) return true;
  for (const rc of SHELL_RC) if (name.startsWith(rc) && /^[._~-]/.test(name.slice(rc.length))) return true;
  return false;
}

/** Whether absolute parts are a shell startup file or a preferences file under a home folder. */
function homeShellParts(parts: readonly string[]): boolean {
  return underHome(parts) && (shellRcName(parts[parts.length - 1] ?? "") || preferencesIn(parts));
}

/** The chat's folder as folded absolute parts, or null when there is none. */
function foldedFolder(folder: string | undefined): string[] | null {
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
  // the file secrets, review lows).
  let patternSeen = false;
  for (const [index, word] of words.entries()) {
    if (searches && pieces(word).some((piece) => GLOB.test(piece))) return word;
    if (searches && head !== "find" && index > 0 && !patternSeen && patternLike(word)) {
      patternSeen = true;
      continue;
    }
    for (const piece of pieces(word)) {
      if (piece && (homeShellFile(piece, folder) || credentialPath(piece))) return piece;
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
    if (path.includes("\0") || homeShellFile(path, folder) || credentialPath(path)) return path;
  }
  return null;
}

/** Whether prose names a credential file: only path-shaped words count, so ordinary text is left alone. */
export function credentialInText(text: string): boolean {
  for (const raw of text.split(/[^a-z0-9_.~/-]+/)) {
    const word = raw.replace(/^[.~/-]+$/, "");
    if (!word) continue;
    if (!word.includes("/") && !word.includes(".") && !word.includes("~")) continue;
    if (credentialPath(word)) return true;
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

/** The chat's folder as parts; null when there is none or it is too shallow to be a chat's own. */
function folderParts(folder: string | undefined): string[] | null {
  const root = folder?.replace(/\/+$/, "");
  if (!root || !root.startsWith("/")) return null;
  const parts = normalise(root);
  return parts && parts.length >= 3 ? parts : null;
}

/**
 * Whether a folder walk waits for Ash. A walk from the home folder, a parent of the chat's folder, `/`, a credential
 * folder, `..` or anywhere else outside the folder is held. A search that turns the ignore rules off (`-u`, `-uu`,
 * `-uuu`, `--no-ignore*`, `--hidden`) is held even inside the chat's folder, because it reads what a project keeps out
 * of git. Recursive `grep` (`-r`, `-R`, `--recursive`, `-d recurse`) has no ignore list, so it is held wherever it
 * starts. When no folder is known, any other walk still has to start at a relative place: the shell's working folder
 * is the chat's own, but nothing absolute can be shown to be inside it.
 */
export function walkHeld(words: readonly string[], folder: string | undefined): boolean {
  if (!words.length) return true;
  const head = words[0];
  const args = words.slice(1);
  if (ignoreOff(head, args) || (head === "grep" && grepRecurses(args))) return true;
  if (!walksFolders(head, args)) return false;
  const root = folderParts(folder);
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    // Home-relative words and anything through a credential place are outside the chat's folder however they resolve.
    if (arg.startsWith("~") || credentialPath(arg)) return true;
    if (!root) {
      // No folder known: only a relative place below the working folder can be shown to stay inside it.
      if (arg.startsWith("/")) return true;
      const rel = normalise(`/${arg}`);
      if (!rel || arg.split("/").includes("..")) return true;
      continue;
    }
    const place = normalise(arg.startsWith("/") ? arg : `/${[...root, arg].join("/")}`);
    if (!place || place.length < 3) return true;
    if (!startsWith(place, root)) return true;
  }
  return false;
}
