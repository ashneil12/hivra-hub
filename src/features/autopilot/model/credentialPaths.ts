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
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "hivra"],
  [".config", "hermes"],
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

/** Whether a stretch of `parts` is one of the places, in order. */
function placeAmong(parts: readonly string[]): boolean {
  return PLACES.some((place) => {
    for (let i = 0; i + place.length <= parts.length; i++) {
      if (place.every((segment, j) => parts[i + j] === segment)) return true;
    }
    return false;
  });
}

/** Whether a path names a credential place or a credential file, by any segment. */
export function credentialPath(path: string): boolean {
  const parts = path
    .toLowerCase()
    .replace(/\\/g, "/")
    .split(/[/:]/)
    .filter(Boolean);
  if (!parts.length) return false;
  if (parts[parts.length - 1] === "known_hosts") return false;
  if (placeAmong(parts)) return true;
  // A folder that holds logins (`secrets/`, `.ssh/`) makes every file under it a credential place too.
  if (parts.slice(0, -1).some((part) => STEMS.has(part) || NAMES.has(part))) return true;
  return credentialName(parts[parts.length - 1]);
}

/** The pieces of a word that can name a path: the word, its bare form, and an `--opt=value` value. */
function pieces(word: string): string[] {
  const out = [word];
  const bare = word.replace(/^-+/, "");
  if (bare !== word) out.push(bare);
  if (bare.includes("=")) out.push(bare.slice(bare.indexOf("=") + 1));
  return out;
}

/** Whether a word looks like a pattern rather than a path: a plain word with no slash, dot or tilde. */
function patternLike(word: string): boolean {
  return !/[./~\\]/.test(word) && !word.startsWith("-");
}

/**
 * The credential place or file a command names, or null. A command that searches (`grep`, `rg`, `ag`, `fd`) reads its
 * first bare word as a pattern, so a search for the word `token` is a search, not a file, and passes.
 */
export function credentialInWords(words: readonly string[]): string | null {
  const head = words[0]?.replace(/^-+/, "") ?? "";
  const searches = head === "grep" || head === "rg" || head === "ag" || head === "fd";
  for (const word of words) {
    if (searches && patternLike(word)) continue;
    for (const piece of pieces(word)) {
      if (piece && credentialPath(piece)) return piece;
    }
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

/** Options that make a search ignore the project's ignore rules. */
const UNRESTRICTED = new Set(["--unrestricted", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent", "--no-ignore-global", "--no-ignore-dot"]);

/** Whether an argument is one of those options: a long name exactly, or a short cluster that carries `u`. */
function unrestricted(arg: string): boolean {
  const name = arg.split("=", 1)[0].toLowerCase();
  if (UNRESTRICTED.has(name)) return true;
  return /^-[^-]/.test(name) && name.slice(1).includes("u");
}

/** Whether a command walks folders rather than reading the files it is named. */
function walksFolders(head: string, args: readonly string[]): boolean {
  switch (head) {
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
 * Whether a command that walks folders starts inside the chat's own folder. A walk from the home folder, a parent of
 * it, `/`, a credential folder, `..` or anywhere else outside the folder is held. A search with the ignore rules off
 * is held the same way, since it reads what a project keeps out of git. When no folder is known, a walk still has to
 * start at a relative place below it: the shell's working folder is the chat's own, but nothing absolute can be shown
 * to be inside it.
 */
export function walkHeld(words: readonly string[], folder: string | undefined): boolean {
  if (!words.length) return true;
  const head = words[0];
  const args = words.slice(1);
  if (!walksFolders(head, args) && !(args.some(unrestricted) && (head === "rg" || head === "ag" || head === "grep"))) return false;
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
