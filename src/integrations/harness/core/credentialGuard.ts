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
  "Bash(*git*push* -n *)",
  "Bash(*git*push* -n)",
  "Bash(*git*commit*--no-v*)",
  "Bash(*git*commit* -n *)",
  "Bash(*git*commit* -n)",
  "Bash(*core.hooksPath*)",
  "Bash(*GIT_CONFIG_*)",
  "Bash(*--config-env*)",
  "Bash(*git* -c alias.*)",
];

const GIT_HOOK_SKIP: readonly RegExp[] = [
  // a push or commit with --no-verify (or any unambiguous prefix of it), or -n
  /\bgit\b[^;&|\n]*\b(?:push|commit)\b[^;&|\n]*(?:--no-v\w*|\s-n(?=\s|$))/i,
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
  if (/\bgit\b/.test(plain) && /no-v[a-z]*/i.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  if (/\bgit\b/.test(plain) && /\benv\b[^;&|\n]*\s-[i-]\b/.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  if (/\bgit\b/.test(plain) && /\bsend-pack\b/.test(plain)) return GIT_HOOK_BLOCK_MESSAGE;
  return undefined;
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
  "Bash(*monocode-hub*attribution/*)",
];

/** A path or command that names the allow list or the crew hooks folder. */
const GUARD_STORE = /commit-guard-allows|monocode-hub[^\s"'`;|&]*\/attribution(?:\/|\b)/i;

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
  const hookSkip = gitHookSkipBlock(call.command);
  if (hookSkip) return hookSkip;
  const texts0 = [call.command ?? "", ...(call.paths ?? [])];
  if (texts0.some((text) => GUARD_STORE.test(text))) return GUARD_STORE_BLOCK_MESSAGE;
  const secret = secretActionBlock(call.command);
  if (secret) return secret;
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
