// r65 (PM's r63 #13): the Hivra Lead tried `security find-generic-password`. No Mono or worker reads a saved password,
// key or token: the keychain, the agents' own sign-in files, or a .env outside the project it works in. This is enforced
// in code for every harness (registry.ts, claude.ts) and as Claude Code deny rules at launch, never as a rule in a soul.
// A blocked call tells the agent to ask Ash for the thing instead of retrying, which shows as a provide card.

/** What the agent reads back when a call is blocked. Raising the ask is what shows Ash the provide card. */
export const CREDENTIAL_BLOCK_MESSAGE =
  "Blocked by MonoCode: that reads a saved password, key or token, which agents never do. Don't retry it or look for it another way. If you need it, ask Ash on its own line: \"Needs Ash (provide): <what you need and why>\".";

/**
 * WP-200 (PR #227 review, item 3): a crew's push or commit must go through the hooks the crew was started with. The
 * pre-push hook checks secrets and agent files before anything leaves, and the commit hooks add attribution, so a
 * command that turns them off is held like a secret action. A person in their own shell can still skip a hook; this
 * stops the agent's shell only.
 */
export const GIT_HOOK_BLOCK_MESSAGE =
  "Blocked by MonoCode: a push or commit that skips the hooks, or points git at another hooks folder or config, skips the secret and attribution checks. Don't retry it or look for another way. Push or commit with the normal command. If a check refuses, read its line and ask Ash on its own line: \"Needs Ash (provide): <what the check refused and why>\".";

/** Claude Code deny rules for the same skips (every Claude process and hub chat carries them). */
export const GIT_HOOK_DENY_RULES: readonly string[] = [
  "Bash(*git*push*--no-v*)",
  "Bash(*git*commit*--no-v*)",
  "Bash(git commit -n)",
  "Bash(git commit -n *)",
  "Bash(*core.hooksPath*)",
  "Bash(*GIT_CONFIG_*)",
  "Bash(*--config-env*)",
  "Bash(*git* -c alias.*)",
];

const GIT_HOOK_SKIP: readonly RegExp[] = [
  // a push or commit with --no-verify (or any unambiguous prefix of it). `-n` is judged on that command's own
  // arguments, below: a later `grep -n` is not a hook skip.
  /\bgit\b[^;&|\n]*\b(?:push|commit)\b[^;&|\n]*--no-v\w*/i,
  // another hooks folder, set on the command line, in the environment, or in config
  /core\.hookspath/i,
  // git's environment overrides of its own configuration
  /\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM|NOSYSTEM)\b/,
  // an alias that can carry a skip under another name
  /\bgit\b[^;&|\n]*\s-c\s*=?\s*alias\./i,
  /\bgit\b[^;&|\n]*--config-env\b/i,
];

/**
 * The reason a command skips a git hook, or undefined. The command is read twice: as typed, and with its quotes taken
 * out, since the shell joins `--'no-verify'` and `core.hooks''Path` back into one word. A flag named through a variable
 * (`V=--no-verify; git push $V`), a clean environment (`env -i`) and `git send-pack` are held as well (N4).
 */
export function gitHookSkipBlock(command?: string): string | undefined {
  if (!command) return undefined;
  const plain = command.replace(/["'\\`]/g, "");
  if (GIT_HOOK_SKIP.some((pattern) => pattern.test(command) || pattern.test(plain))) return GIT_HOOK_BLOCK_MESSAGE;
  // M6: only a command that pushes or commits is held for its flags. A git read, an unrelated env prefix or a
  // branch name is ordinary work.
  const pushOrCommit = /\bgit\b[^;&|\n]*\b(?:push|commit)\b/.test(plain);
  // A variable (`V=--no-verify; git push $V`) still matches the loose text. `-n` does not: it is only a flag of the
  // git push or commit itself.
  if (pushOrCommit && /--no-v[a-z]*|\bno-verify\b/.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  if (gitPushOrCommitSkips(command)) return GIT_HOOK_BLOCK_MESSAGE;
  if (pushOrCommit && /\benv\s+(?:-i\b|--ignore-environment\b|-\s)/.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  if (/\bgit\b[^;&|\n]*\bsend-pack\b/.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  return undefined;
}

/** One shell command, split on `&&`, `||`, `;`, `|` and newlines, but not inside quotes. */
function shellSegments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "|" || char === ";" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/**
 * `--no-v…` on the git push or commit itself, or `-n` on a commit (there `-n` is `--no-verify`; on a push it is
 * `--dry-run` and is not held). A combined short cluster counts (`commit -nm`, `commit -anm`). A short option that
 * takes a value (`-m`, `-F`, `-c`, `-C`) consumes the rest of its cluster when it is not the last letter (`-mn` is
 * the message "n", not `-n`), otherwise the next word. Words after `--` are not flags. A later command in the same
 * line is not this git's arguments.
 */
function gitPushOrCommitSkips(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const gitAt = words.findIndex((word) => word === "git" || word.endsWith("/git"));
    if (gitAt < 0) continue;
    const args = words.slice(gitAt + 1);
    const verbAt = args.findIndex((arg) => arg === "push" || arg === "commit");
    if (verbAt < 0) continue;
    const commit = args[verbAt] === "commit";
    for (let i = verbAt + 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") break;
      if (arg.startsWith("--no-v")) return true;
      if (arg === "--message" || arg === "--file") {
        i += 1;
        continue;
      }
      if (arg.startsWith("--")) continue;
      if (!arg.startsWith("-") || arg.length < 2) continue;
      const cluster = arg.slice(1);
      let takesNext = false;
      for (let c = 0; c < cluster.length; c++) {
        const flag = cluster[c];
        if (commit && flag === "n") return true;
        if (commit && (flag === "m" || flag === "F" || flag === "c" || flag === "C")) {
          if (c < cluster.length - 1) break;
          takesNext = true;
          break;
        }
      }
      if (takesNext) i += 1;
    }
  }
  return false;
}

/** What an agent reads back when it tries to write the commit guard's allow list or the crew hooks. */
export const GUARD_STORE_BLOCK_MESSAGE =
  "Blocked by MonoCode: the commit guard's allow list and its crew hooks are the app's own, and agents never write them. Don't retry it or look for another way. If a check refuses, read its line and ask Ash on its own line: \"Needs Ash (provide): <what the check refused and why>\".";

/** Deny rules for the allow list and the crew hooks folder, in the app's data folder (every Claude process carries them). */
export const GUARD_STORE_DENY_RULES: readonly string[] = [
  "Edit(~/Library/Application Support/com.ash.monocode-hub*/commit-guard-allows*)",
  "Write(~/Library/Application Support/com.ash.monocode-hub*/commit-guard-allows*)",
  "Edit(~/Library/Application Support/com.ash.monocode-hub*/attribution/**)",
  "Write(~/Library/Application Support/com.ash.monocode-hub*/attribution/**)",
  "Bash(*commit-guard-allows*)",
  "Bash(*Application Support/com.ash.monocode-hub*attribution/*)",
];

/** A path or command that names the allow list or the crew hooks folder. */
const GUARD_STORE = /Application Support\/com\.ash\.monocode-hub[^\s"'`;|&]*\/(?:commit-guard-allows|attribution)(?:\/|\b)/i;

/** Claude Code permission rules, passed as --disallowedTools; deny rules hold even in bypass mode. */
export const CREDENTIAL_DENY_RULES: readonly string[] = [
  ...GIT_HOOK_DENY_RULES,
  ...GUARD_STORE_DENY_RULES,
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
  // Round 4, item 1: pi's and omp's login stores (API keys and OAuth tokens in plain JSON).
  "Read(~/.pi/agent/auth.json)",
  "Read(~/.omp/agent/auth.json)",
  "Read(~/.aws/credentials)",
  "Read(~/.netrc)",
  "Read(~/.ssh/**)",
  "Read(~/.config/gh/hosts.yml)",
  "Read(~/.local/share/claude-gpt/**)",
  "Read(~/Library/Keychains/**)",
  "Read(~/.env*)",
];

/**
 * r67 (Alfred's r66 rechecks, 29 Oct): ed answered "what did I say about models" by running sqlite3 on the app's own
 * database, and other Monos read sessions, delegations and transcripts out of monocode.db by hand. No agent reads the
 * hub's database or the window's storage directly: it is Ash's whole history, half-written while the app runs, and the
 * MonoCode tools already give the parts an agent may see. Enforced like the keychain rule, in code for every harness.
 */
export const HUB_DB_BLOCK_MESSAGE =
  "Blocked by MonoCode: agents never read the app's database or the window's storage directly. Don't retry it or look for it another way. Use the MonoCode tools: task_status for work and workers, room_read for a room's messages, and your own memory files for what Ash said. If none of them has it, say so plainly.";

/** The same, as Claude Code deny rules for every hub chat. */
export const HUB_DB_DENY_RULES: readonly string[] = [
  "Bash(*com.ash.monocode-hub*.db*)",
  "Bash(*com.ash.monocode-hub*sqlite*)",
  "Read(~/Library/Application Support/com.ash.monocode-hub*/*.db*)",
  "Read(~/Library/WebKit/com.ash.monocode-hub*/**)",
  // Round 6, HIGH-1: the copies a ship, a recovery and a backup leave in the Archive folder.
  "Read(~/Archive/monocode/**/monocode.db*)",
  "Bash(*Archive/monocode*monocode.db*)",
  // WP-129: the daily app's data folder holds its own records (chats, saved routes, key addresses). Hub chats never
  // write or edit it, and never run a command that names it. The pattern is the exact daily folder: a dev slot's
  // folder (com.ash.monocode-hub.dev.<slot>) keeps its agent-memory there and must stay writable. The app's file
  // commands refuse the daily folder too.
  "Write(~/Library/Application Support/com.ash.monocode-hub/**)",
  "Edit(~/Library/Application Support/com.ash.monocode-hub/**)",
  "Bash(*Application Support/com.ash.monocode-hub/*)",
  "Bash(*Application Support/com.ash.monocode-hub\"*)",
  "Bash(*Application Support/com.ash.monocode-hub'*)",
  "Bash(*Application Support/com.ash.monocode-hub)",
];

/** The app's data folder (the daily app or any dev slot) or its WebKit storage, then a database file in it. */
const HUB_DB = /(?:Application Support\/com\.ash\.monocode-hub[^/\s"']*\/[^\s"';|&)]*\.(?:db|sqlite3?)(?:-wal|-shm)?\b|\/WebKit\/com\.ash\.monocode-hub|Archive\/monocode\/[^\s"';|&)]*monocode\.db)/i;
/** A bare monocode.db read by a database tool from wherever the shell happens to be. */
const HUB_DB_TOOL = /(^|[\s;&|(`$])(?:\/usr\/bin\/)?sqlite3\b[^;&|]*\bmonocode\.db\b/i;

const KEYCHAIN = /(^|[\s;&|(`$])(\/usr\/bin\/)?security\s+(find-[\w-]+|dump-keychain|export|unlock-keychain)\b/;
/**
 * The home folder in every spelling a login file's path takes: ~, $HOME, a Mac or Linux home (with the Mac's /.nofollow/
 * and /.resolve/<n>/ prefixes), and a Windows drive (C:/Users/<me>). Matched against foldForSecrets' text (round 3, item 2).
 */
const HOME = String.raw`(?:~|\$\{?home\}?|%userprofile%|\/root|(?:[a-z]:)?(?:\/\.nofollow|\/\.resolve\/\d+)?\/(?:users|home)\/[^/\s]+)`;
const SECRET_FILES: readonly RegExp[] = [
  new RegExp(`${HOME}\\/\\.claude\\/\\.credentials`),
  new RegExp(`${HOME}\\/\\.claude\\.json\\b`),
  new RegExp(`${HOME}\\/\\.codex\\/auth\\.json`),
  // Round 4, item 1: pi's and omp's login stores, the same as the deny rules above.
  new RegExp(`${HOME}\\/\\.pi\\/agent\\/auth\\.json`),
  new RegExp(`${HOME}\\/\\.omp\\/agent\\/auth\\.json`),
  new RegExp(`${HOME}\\/\\.aws\\/credentials`),
  new RegExp(`${HOME}\\/\\.netrc\\b`),
  new RegExp(`${HOME}\\/\\.ssh\\/(id_|.*key)`),
  new RegExp(`${HOME}\\/\\.config\\/gh\\/hosts\\.yml`),
  new RegExp(`${HOME}\\/\\.local\\/share\\/claude-gpt\\/`),
  // Windows: the same files under the Windows profile, with the 8.3 short names (CODEX~1, AUTH~1.JSO) a Windows path may use.
  /\/\.?codex~\d\/auth~\d/,
  // AppData stores: GitHub CLI, rclone, npm's configuration, and the browsers' saved passwords.
  /\/appdata\/roaming\/github cli\/hosts\.yml/,
  /\/appdata\/roaming\/rclone\/rclone\.conf/,
  /\/appdata\/roaming\/npm\/etc\/npmrc/,
  /\/appdata\/local\/(google\/chrome|microsoft\/edge)\/user data\/.*login data/,
  /\/library\/keychains\//,
];

/**
 * A command or path as a Mac, Linux or Windows file system compares it for the login-file rules: lower case, one kind of
 * slash, and trailing dots and spaces dropped per segment (`.codex.\\auth.json` is `.codex/auth.json`).
 */
/**
 * Round 5, H1: a climb (`name/..`) is cancelled against the name before it, at any depth, so `a:b/../../.ssh/id_rsa` reads
 * as `.ssh/id_rsa`. Names are split on "/" only, as the file system splits them.
 */
function collapseClimbs(text: string): string {
  let out = text.replace(/\/\.(?=\/|$)/g, "");
  let before: string;
  do {
    before = out;
    out = out.replace(/\/[^/\s]+\/\.\.(?=\/|$|\s)/g, "");
  } while (out !== before);
  return out;
}

function foldForSecrets(text: string): string {
  return text.toLowerCase().replace(/\\/g, "/").replace(/(?<=[^. /])[. ]+(?=\/|$)/gm, "");
}
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
  const hookSkip = gitHookSkipBlock(call.command);
  if (hookSkip) return hookSkip;
  const texts0 = [call.command ?? "", ...(call.paths ?? [])];
  if (texts0.some((text) => GUARD_STORE.test(text))) return GUARD_STORE_BLOCK_MESSAGE;
  const secret = secretActionBlock(call.command);
  if (secret) return secret;
  const texts = [call.command ?? "", ...(call.paths ?? [])].filter(Boolean);
  for (const raw of texts) {
    // Round 4, item 7: quotes are the shell's, not the path's (`"$HOME"/.codex`, `~/.co''dex`), so the text is read both as
    // written and with its quotes taken out.
    // Round 7, MED-E: a backslash escapes the next character in the shell (`Application\ Support`, `monocode.d\b`), so the
    // text is read with its backslashes taken out as well, for every guard below.
    for (const text of new Set([raw, raw.replace(/['"]/g, ""), raw.replace(/[\\'"]/g, "")])) {
      if (KEYCHAIN.test(text)) return CREDENTIAL_BLOCK_MESSAGE;
      if (SECRET_FILES.some((re) => re.test(foldForSecrets(collapseClimbs(text))))) return CREDENTIAL_BLOCK_MESSAGE;
      // Round 6, HIGH-1: the hub's store is read with its quotes taken out too (`'.../com.ash.monocode-h'ub/...`).
      if (HUB_DB.test(text) || HUB_DB_TOOL.test(text)) return HUB_DB_BLOCK_MESSAGE;
    }
    const padded = ` ${raw}`;
    for (const match of padded.matchAll(ENV_PATH)) {
      if (!insideProject(match[1], cwd, home)) return CREDENTIAL_BLOCK_MESSAGE;
    }
  }
  return undefined;
}

/**
 * r69 (PM's blind r67, E7): asked "can u get it rotated", the Hivra Lead loaded the Resend key with `vercel env run` and
 * started a script with it before Claude Code's classifier stopped it. No Lead or worker rotates, loads, exports or
 * prints a secret, or runs a command with secrets injected: that is Ash's to do. Enforced like the keychain rule: deny
 * rules every Claude process carries (they hold in auto and bypass mode, so the tool never runs), this check in code for
 * every harness, and a finished turn that tried one reads as Needs Ash (chatQuestions.ts), a red row.
 */
export const SECRET_ACTION_BLOCK_MESSAGE =
  "Blocked by MonoCode: that rotates, loads, exports or prints a secret, or runs a command with secrets injected, which agents never do. Don't retry it or look for another way. Stop and ask Ash on its own line: \"Needs Ash (provide): <the key or secret action and why>\".";

/**
 * Claude Code deny rules for every Claude process (hubMcp.ts chatDeniedTools). r72 (29 Oct): narrowed after checking
 * 21 days of real Claude chats on Ash's Mac: names-only listings (`gh secret list`, `wrangler secret list`, `fly
 * secrets list`), one plain variable (`printenv CLAUDE_CODE_SESSION_ID`, `docker exec … printenv HERMES_HOME`) and
 * "api_keys" in a PR body, table list or branch name are ordinary work, not a secret action.
 */
export const SECRET_ACTION_DENY_RULES: readonly string[] = [
  "Bash(*vercel env run*)",
  "Bash(*vercel env pull*)",
  "Bash(*vercel env add*)",
  "Bash(*vercel env rm*)",
  "Bash(*vercel env update*)",
  "Bash(*vercel secrets*)",
  "Bash(*netlify env:get*)",
  "Bash(*netlify env:set*)",
  "Bash(*netlify env:import*)",
  "Bash(*doppler run*)",
  "Bash(*doppler secrets*)",
  "Bash(op run:*)",
  "Bash(op read:*)",
  "Bash(op inject:*)",
  "Bash(op item get:*)",
  // WP-92: the launcher is the app's own, signed call; a worker cannot run it itself.
  "Bash(*monocode secret-run*)",
  "Bash(*infisical run*)",
  "Bash(*infisical export*)",
  "Bash(*dotenv run*)",
  "Bash(*dotenvx run*)",
  "Bash(*heroku config*)",
  "Bash(*fly secrets set*)",
  "Bash(*fly secrets unset*)",
  "Bash(*fly secrets import*)",
  "Bash(*flyctl secrets set*)",
  "Bash(*flyctl secrets unset*)",
  "Bash(*flyctl secrets import*)",
  "Bash(*railway run*)",
  "Bash(*railway variables*)",
  "Bash(*wrangler secret put*)",
  "Bash(*wrangler secret delete*)",
  "Bash(*wrangler secret bulk*)",
  "Bash(*supabase secrets*)",
  "Bash(*supabase projects api-keys*)",
  "Bash(*gh secret set*)",
  "Bash(*gh secret delete*)",
  "Bash(*gh secret remove*)",
  "Bash(*aws secretsmanager*)",
  "Bash(*gcloud secrets*)",
  "Bash(*keyvault secret*)",
  "Bash(printenv)",
  "Bash(printenv |*)",
  "Bash(printenv >*)",
  "Bash(*printenv *KEY*)",
  "Bash(*printenv *TOKEN*)",
  "Bash(*printenv *SECRET*)",
  "Bash(*printenv *PASSWORD*)",
  "Bash(env)",
  "Bash(env |*)",
  "Bash(export -p*)",
  "Bash(*curl *api-keys*)",
  "Bash(*curl *api_keys*)",
  "Bash(*wget *api-keys*)",
  "Bash(*wget *api_keys*)",
  "Bash(*https://*/api-keys*)",
  "Bash(*https://*/api_keys*)",
];

/** One shell segment's command start (after `cd x &&`, `;`, `|`, `$(`, a backtick, `sudo`, `npx`, `bunx`, `pnpm dlx`). */
const AT = String.raw`(?:^|[\s;&|(\x60$])(?:(?:sudo|npx|bunx|pnpm\s+dlx|yarn\s+dlx|command)\s+(?:-\S+\s+)*)?`;
const SECRET_ACTIONS: readonly RegExp[] = [
  // The secret launcher, invoked from a shell line: `monocode secret-run`, or any `secret-run --grant...` (the grant is
  // the app's own, never a worker's to carry). A word that merely names it is ordinary text.
  new RegExp(String.raw`\bmonocode\S*\s+secret-run\b|\bsecret-run\s+--grant`, "i"),
  // a platform's env or secret store: loading, pulling, setting, removing, running with it injected
  new RegExp(String.raw`${AT}vercel\s+(?:env\s+(?:run|pull|add|rm|remove|update)|secrets?)\b`, "i"),
  new RegExp(String.raw`${AT}netlify\s+env:(?:get|set|import|unset|clone)\b`, "i"),
  new RegExp(String.raw`${AT}doppler\s+(?:run|secrets)\b`, "i"),
  new RegExp(String.raw`${AT}op\s+(?:run|read|inject|item\s+get)\b`, "i"),
  new RegExp(String.raw`${AT}infisical\s+(?:run|export|secrets)\b`, "i"),
  new RegExp(String.raw`${AT}dotenvx?\s+(?:run\b|-e\b|-f\b|--\s)`, "i"),
  new RegExp(String.raw`${AT}heroku\s+config\b`, "i"),
  new RegExp(String.raw`${AT}(?:fly|flyctl)\s+secrets\s+(?:set|unset|import)\b`, "i"),
  new RegExp(String.raw`${AT}railway\s+(?:run|variables)\b`, "i"),
  new RegExp(String.raw`${AT}wrangler\s+secret\s+(?:put|delete|bulk)\b`, "i"),
  new RegExp(String.raw`${AT}supabase\s+(?:secrets|projects\s+api-keys)\b`, "i"),
  new RegExp(String.raw`${AT}gh\s+secret\s+(?:set|delete|remove)\b`, "i"),
  new RegExp(String.raw`${AT}aws\s+(?:secretsmanager\b|ssm\s+get-parameters?\b.*--with-decryption|iam\s+(?:create|update|delete)-access-key\b)`, "i"),
  new RegExp(String.raw`${AT}gcloud\s+secrets\b`, "i"),
  new RegExp(String.raw`${AT}az\s+keyvault\s+secret\b`, "i"),
  new RegExp(String.raw`${AT}kubectl\s+(?:get|describe|create)\s+secrets?\b`, "i"),
  // an API's key endpoints: creating, rolling or deleting a key (Resend's /api-keys, Stripe's api_keys, …)
  new RegExp(String.raw`${AT}(?:curl|wget|https?|xh)\b[^;&|]*\bapi[-_]keys?\b`, "i"),
  /https?:\/\/[^\s"'<>]*\/api[-_]keys?\b/i,
  // printing the environment
  new RegExp(String.raw`${AT}(?:printenv(?=\s*(?:$|[|;&>)])|\s+[^;&|]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b)|export\s+-p\b)`),
  new RegExp(String.raw`${AT}env\s*(?:$|[|;&>])`),
  // echoing a secret variable
  /\b(?:echo|printf|cat)\b[^;&|]*\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\b/,
  // loading a .env file into the shell
  new RegExp(String.raw`${AT}(?:source|\.)\s+["']?[^\s"';|&]*\.env(?:\.[\w.-]+)?["']?(?=$|[\s;|&)])`),
  // a secret pasted into the command's environment
  /(?:^|[\s;&|(])(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|_KEY|TOKEN|SECRET|PASSWORD)=(?!["']?\$|\s|$)\S/,
];

/** The block for a shell command that rotates, loads, exports or prints a secret, or runs with secrets injected. */
export function secretActionBlock(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return SECRET_ACTIONS.some((re) => re.test(command)) ? SECRET_ACTION_BLOCK_MESSAGE : undefined;
}
