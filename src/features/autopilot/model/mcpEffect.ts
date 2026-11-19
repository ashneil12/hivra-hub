// What an MCP tool call does, from the name the provider gives it (and a description or the server's annotations
// when a call carries them): a read, a change, a high-impact action, or something autopilot can't place. High-impact
// and unknown always wait for Ash; so does everything that isn't a read. The red list (redList.ts) is checked before
// this and cannot be overridden by it.
//
// Translated from Row-Bot, `src/row_bot/mcp_client/safety.py` (Apache-2.0, Copyright 2026 Row-Bot Contributors).
// Changed for Hivra: Python types became TypeScript; the verb patterns are written out as word lists instead of being
// scraped back out of Python's pattern source; Row-Bot's fifth class, "interaction" (a reviewed browser session), is
// folded into "change" so nothing but a read can pass; and the provider's tool id is split into its server and tool so
// the caller can tell where the server came from.

export type McpEffect = "read_only" | "change" | "high_impact" | "unknown";

/** The server's annotations Row-Bot weighs. A call's own approval request doesn't carry them today. */
export type McpHints = { readOnlyHint?: boolean; destructiveHint?: boolean };

const words = (parts: string) => parts.split("|");

const DESTRUCTIVE_WORDS = words(
  "delete|remove|destroy|drop|purge|erase|wipe|truncate|revoke|uninstall|kill|terminate|cancel|refund|send|post|reply|forward|comment|invite|share|publish|deploy|merge|commit|push|upload|run|exec|execute|shell|command|payment|pay|charge|transfer|withdraw|trade|buy|sell|order|book|grant|permission|permissions|reset|overwrite|eval",
);
const SENSITIVE_WORDS = words(
  "email|emails|message|messages|release|releases|script|scripts|password|passwords|role|roles|member|members|collaborator|collaborators|token|tokens|secret|secrets|key|keys|admin|admins|owner|owners|webhook|webhooks|pull_request|pull_requests|user|users|visibility|membership|memberships|repository|repositories|repo|repos",
);
const REPOSITORY_WORDS = words("repository|repositories|repo|repos");
const ROUTINE_WORDS = words("create|add|update|edit|write|set|rename|move|put|patch|modify|insert|append|save|assign|duplicate");
const ROUTINE_FIRST_WORDS = words("tag|label|mark|archive|close|star|link|attach|copy");
const READ_WORDS = words("read|get|list|search|find|inspect|describe|count|query|fetch|status|lookup");

// ---- a read is a closed vocabulary (WP-101 fix round) --------------------------------------------------------------
//
// A name is a read only when every word in it is on these lists. Before, a read verb anywhere near the front was
// enough, so a name that opened with "get" and then said "restart", "start" or "read_secret" passed. Anything not
// listed here, any joining word, any look-alike letter and any name that doesn't parse as plain ASCII words waits.

/** Words that read something. `fetch` is not here: a fetch can carry data out in its URL, so it waits (network). */
const READ_VERBS: ReadonlySet<string> = new Set(words("read|get|list|search|find|inspect|describe|count|query|status|lookup|view|show|check"));

/** Nouns a read may name. Anything not on this list waits, however harmless it looks. */
const HARMLESS_NOUNS: ReadonlySet<string> = new Set(
  words(
    "file|files|folder|folders|directory|directories|path|paths|content|contents|issue|issues|pull|request|requests|doc|docs|document|documents|message|messages|member|members|label|labels|tag|tags|commit|commits|branch|branches|workflow|workflows|run|runs|artifact|artifacts|order|orders|purchase|purchases|post|posts|page|pages|note|notes|user|users|project|projects|repo|repos|repository|repositories|item|items|record|records|report|reports|log|logs|info|detail|details|metadata|summary|history|status|statuses|instance|instances|list|lists|comment|comments|review|reviews|event|events|job|jobs|thread|threads|workspace|workspaces|team|teams|group|groups|channel|channels|version|versions|stock|query|github|profile|profiles",
  ),
);

/** Little words that connect a noun to its verb ("list_by_tag", "get_details_of_a_commit"). */
const PARTICLES: ReadonlySet<string> = new Set(words("a|an|the|of|in|on|for|by|from|at|to|all|my|your"));

/** A joining word says the name does more than one thing, so it is never a plain read. */
const JOINING_TOKENS: ReadonlySet<string> = new Set(words("and|or|then|with"));

/** A word naming a secret makes the tool high impact wherever it sits, after a read verb or not. */
const SENSITIVE_TOKENS: ReadonlySet<string> = new Set(
  words("secret|secrets|token|tokens|password|passwords|passwd|credential|credentials|key|keys|env|ssh|keychain|cookie|cookies|session|sessions|auth|private"),
);

/** A word naming a network destination waits: a read to a URL the agent picks can carry data out. */
const NETWORK_TOKENS: ReadonlySet<string> = new Set(
  words("url|urls|remote|web|http|https|fetch|download|upload|uploads|webhook|webhooks|request|requests|endpoint|endpoints|socket|proxy"),
);

/**
 * A name as plain ASCII words, split on underscore, hyphen and dot and at camelCase; null when it isn't one: any
 * non-ASCII or look-alike letter, a space, punctuation, an empty word, or an empty name. Nothing is cleaned away first,
 * because cleaning is what turned a Cyrillic "delete" into a read.
 */
export function nameTokens(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const cased = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (!/^[a-z0-9]+(?:[_.-][a-z0-9]+)*$/.test(cased)) return null;
  const tokens = cased.split(/[_.-]+/);
  return tokens.length ? tokens : null;
}

/** Whether a word is one a read name may use. "request" after "pull" is a pull request; anywhere else it is network. */
function harmlessWord(tokens: readonly string[], index: number): boolean {
  const word = tokens[index];
  if (READ_VERBS.has(word) || HARMLESS_NOUNS.has(word) || PARTICLES.has(word)) return true;
  if ((word === "request" || word === "requests") && tokens[index - 1] === "pull") return true;
  return false;
}

/** Whether a name is, word for word, a plain read. */
function closedReadName(tokens: readonly string[] | null): boolean {
  // A bare verb ("get", "status") names no object, so it can't say what it reads: it needs a noun after it.
  if (!tokens || tokens.length < 2 || !READ_VERBS.has(tokens[0])) return false;
  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index];
    if (JOINING_TOKENS.has(word)) return false;
    // "pull_request" is a thing, not a destination; a request anywhere else can carry data out.
    const pullRequest = /^requests?$/.test(word) && tokens[index - 1] === "pull";
    if (NETWORK_TOKENS.has(word) && !pullRequest) return false;
    if (!harmlessWord(tokens, index)) return false;
  }
  return true;
}

/** Whether a name says "secret", "token", "key" and the like anywhere in it. */
function namesASecret(tokens: readonly string[] | null): boolean {
  return !!tokens?.some((word) => SENSITIVE_TOKENS.has(word));
}

// ---- what the arguments, not the name, decide (WP-101 fix round 2, item E) -----------------------------------------
//
// The approval request carries no arguments, so these rules judge a name alone. A name that names a page, a URL, a
// file, a path, a shell or SQL can only be judged once the call says which one it is given: `get_page` fetches whatever
// URL it is handed, and a URL can carry data out; `read_file` reads whatever path it is handed. Since nothing here
// reads the arguments, every such name waits for Ash. This is a limit, stated plainly: the arguments are not checked,
// so holding is the only safe answer for a name whose arguments decide what it does.
//
// One exception is kept: a name whose object is the server's own record (issue, commit, branch, workflow) is a read of
// that record, whatever id it is given.

/** Words that say the call's arguments decide where it reads or what it runs. "query" is a database server's. */
const ARG_BLIND_WORDS: ReadonlySet<string> = new Set(
  words(
    "page|pages|link|links|uri|uris|url|urls|href|web|browse|file|files|content|contents|blob|blobs|document|documents|doc|docs|path|paths|folder|folders|directory|directories|dir|dirs|sql|query|queries|shell|shells|exec|execute|run|runs|eval|script|scripts|terminal|process|processes|socket|sockets",
  ),
);

/** A bare verb with no object at all ("query", "search"): only the call's arguments say what it reads. */
const BARE_VERBS: ReadonlySet<string> = new Set(words("query|search|fetch"));

function namesNoObject(tokens: readonly string[] | null): boolean {
  return tokens?.length === 1 && BARE_VERBS.has(tokens[0]) ? true : false;
}

/** Whether the name is one whose arguments decide what it does, so the name alone can't be read. */
function argumentsDecide(tokens: readonly string[] | null): boolean {
  if (!tokens?.length) return false;
  if (namesNoObject(tokens)) return true;
  return tokens.some((word) => ARG_BLIND_WORDS.has(word));
}

/**
 * A word that names something a read returns, once anything the module already knows is set aside: "operation" and
 * "result" are what a read returns, so "frobnicate"/"lookup" named with one is still a read if the server says so.
 */
const READ_RESULT_NOUNS: ReadonlySet<string> = new Set(
  words("operation|operations|result|results|entry|entries|row|rows|object|objects|thing|things|data|value|values|state|signal|response|responses|output|outputs|input|inputs|payload|payloads"),
);

/**
 * Whether a readOnlyHint may be believed: only for a name whose every word the module knows (a read verb, a harmless
 * noun, a particle, or a name of something a read returns), and none of them a change, joining or network word. A word
 * nobody knows ("frobnicate") is not evidence, so it waits.
 */
function hintCanBeBelieved(tokens: readonly string[] | null): boolean {
  if (!tokens?.length) return false;
  return tokens.every((word) => {
    if (JOINING_TOKENS.has(word) || NETWORK_TOKENS.has(word)) return false;
    if (READ_VERBS.has(word) || HARMLESS_NOUNS.has(word) || PARTICLES.has(word) || READ_RESULT_NOUNS.has(word)) return true;
    if (DESTRUCTIVE_WORDS.includes(word) || ROUTINE_WORDS.includes(word) || ROUTINE_FIRST_WORDS.includes(word)) return false;
    const found = readObject(word);
    return found !== null;
  });
}

/** Words that are also nouns: a change only as the name's verb, and never counted in their -s form. */
const NOUNS = new Set(
  words("order|post|comment|share|invite|book|charge|payment|pay|trade|buy|sell|reply|forward|set|add|save|edit|move|put|patch|command|shell|permission|permissions|eval"),
);

/** A name's verb anywhere in it, in the forms a name or a description uses ("delete", "delete_items"). */
const inName = (list: readonly string[]) => new RegExp(`(^|_)(${[...list].sort().join("|")})(_|$)`);
/** The same words as a description says them ("Deletes", "Runs … inserts, updates and deletes"); past and -ing forms
 * stay out, because a read describes what it returns with them ("recently updated", "deleted items"). */
const inDescription = (list: readonly string[]) => {
  const forms = new Set<string>();
  for (const word of list) {
    forms.add(word);
    if (!NOUNS.has(word)) {
      forms.add(`${word}s`);
      forms.add(`${word}es`);
    }
  }
  return new RegExp(`(^|_)(${[...forms].sort().join("|")})(_|$)`);
};
const changeInDescription = inDescription([...ROUTINE_WORDS, "replace", "clear"]);

const DESTRUCTIVE = inName(DESTRUCTIVE_WORDS);
const SENSITIVE = inName(SENSITIVE_WORDS);
const REPOSITORY = inName(REPOSITORY_WORDS);
const ROUTINE = inName(ROUTINE_WORDS);
const ROUTINE_FIRST = new RegExp(`^(?:${[...ROUTINE_FIRST_WORDS].sort().join("|")})(_|$)`);
const READ = new RegExp(`^(?:${[...READ_WORDS].sort().join("|")})(_|$)`);
/** Names that read like a lookup but mark, join or open something (review M2). */
const NOT_READS = /(^|_)(list_items?|check_(in|by)|get_to|view_on)(_|$)/;
/** A read that says it runs a read ("Execute a SELECT query") is still a read. */
const RUNS_A_READ = /(^|_)(run|exec|execute)s?_(an?_|the_)?(select|search|read_only|readonly)(?!_into)(_|$)/g;
const SAYS_HIGH_IMPACT = inDescription(DESTRUCTIVE_WORDS);

/** High-impact words that are also what a read returns: get_commit reads a commit, get_order an order. */
const READ_OBJECTS = new Set(
  words("commit|run|order|post|comment|share|invite|book|charge|payment|reply|command|merge|push|deploy|upload|permission"),
);
/** Straight after the read verb, a singular object is a noun only last or before one of these. */
const NOUN_AFTER = new Set(
  words("id|ids|detail|details|status|statuses|log|logs|info|history|items|files|metadata|summary|count|artifacts|usage|jobs|comments|reviews"),
);
/** In a description, an object is a noun after one of these, never straight after a joining word. */
const BEFORE_A_NOUN = new Set(
  words("a|an|the|each|this|that|its|their|your|one|of|for|by|from|about|specific|given"),
);
const JOINING = new Set(words("and|then|or|to"));

/** Browser tools Row-Bot lets a reviewed browser session use without asking; Hivra counts them as changes. */
const BROWSER_SESSION_TOOLS = new Set(
  words(
    "browser_click|browser_close|browser_console_messages|browser_drag|browser_fill_form|browser_hover|browser_navigate|browser_navigate_back|browser_network_requests|browser_press_key|browser_resize|browser_select_option|browser_snapshot|browser_take_screenshot|browser_wait_for",
  ),
);
const BROWSER_READS = new Set(
  words("browser_console_messages|browser_network_requests|browser_snapshot|browser_take_screenshot|browser_wait_for"),
);

/**
 * A name as one underscore-joined identifier: "File Server!" becomes "file_server". Change from Row-Bot: camelCase
 * is split too ("chat_postMessage" becomes "chat_post_message"), because JavaScript servers name their tools that way.
 */
export function sanitizeNameComponent(value: unknown): string {
  const text = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return text || "unnamed";
}

/** A provider tool id's server and tool ("mcp__plugin-a-b__get_x"), or null when it isn't one. */
export function splitMcpTool(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const tool = rest.slice(split + 2);
  if (!tool) return null;
  return { server: rest.slice(0, split), tool };
}

/** The read object a word names and whether it is plural ("commits" is ("commit", true)), or null. */
function readObject(word: string): [string, boolean] | null {
  if (READ_OBJECTS.has(word)) return [word, false];
  for (const cut of [word.length - 1, word.length - 2]) {
    const base = word.slice(0, cut);
    if (READ_OBJECTS.has(base) && (word === `${base}s` || word === `${base}es`)) return [base, true];
  }
  return null;
}

/**
 * What a plain read names as its object ("get_commit" names a commit), or null when the name is not a plain read: no
 * read verb first, a joining word ("get_and_push"), a singular object where a verb could stand ("search_book_flight"),
 * or a high-impact word that is not something a read returns ("read_delete_log").
 */
function readObjects(name: string): Set<string> | null {
  const parts = name.split("_");
  if (!READ.test(name) || parts.some((part) => JOINING.has(part))) return null;
  const objects = new Set<string>();
  for (let index = 1; index < parts.length; index++) {
    const found = readObject(parts[index]);
    if (!found) {
      if (DESTRUCTIVE_WORDS.includes(parts[index])) return null;
      continue;
    }
    const [base, plural] = found;
    const after = index + 1 < parts.length ? parts[index + 1] : "";
    if (!plural && index === 1 && after && !NOUN_AFTER.has(after)) return null;
    objects.add(base);
  }
  return objects;
}

/** A read's description without the objects it names as nouns ("Get details for a commit"), so only what it says it
 * does is weighed; "or post a new one" keeps its verb. */
function withoutObjects(description: string, objects: ReadonlySet<string>): string {
  const parts = description.split("_");
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const found = readObject(parts[index]);
    const noun =
      found !== null &&
      objects.has(found[0]) &&
      (index === 0 || !JOINING.has(parts[index - 1])) &&
      (found[1] ||
        parts.slice(Math.max(0, index - 3), index).some((part) => BEFORE_A_NOUN.has(part)) ||
        (index + 1 < parts.length && NOUN_AFTER.has(parts[index + 1])));
    if (!noun) kept.push(parts[index]);
  }
  return kept.join("_");
}

const changes = (name: string) => ROUTINE.test(name) || ROUTINE_FIRST.test(name);

/** create_release, add_collaborator, set_password: a routine verb on something high impact, or on something its
 * description puts in a repository. */
function sensitiveChange(name: string, description: string): boolean {
  return changes(name) && (SENSITIVE.test(name) || REPOSITORY.test(sanitizeNameComponent(description)));
}

/**
 * What a tool does. Trusted in this order: a destructiveHint; a name that says a word for a secret; a high-impact
 * name; a change named as one (which its description can still make high impact); a plain read name, which is every
 * word on the closed lists below; and only then the description. A read-only hint never outweighs a name, a
 * description never outweighs either of them, and neither can turn a name that isn't on the lists into a read.
 */
export function toolEffect(toolName: string, description = "", hints: McpHints = {}): McpEffect {
  const name = sanitizeNameComponent(toolName);
  const said = sanitizeNameComponent(description);
  const tokens = nameTokens(toolName);
  const objects = tokens?.length ? readObjects(name) : null;
  if (hints.destructiveHint === true || namesASecret(tokens) || (DESTRUCTIVE.test(name) && objects === null) || sensitiveChange(name, description))
    return "high_impact";
  // These read like lookups but change something or join one (check in, view on, get to): held whatever they say (M2).
  if (NOT_READS.test(name)) return "unknown";
  if (BROWSER_READS.has(name)) return "read_only";
  if (BROWSER_SESSION_TOOLS.has(name)) return "change";
  if (changes(name)) {
    // Its description can make a change high impact, unless the server says it isn't destructive: words such as
    // "share" or "comment" in a description are often nouns.
    return SAYS_HIGH_IMPACT.test(said) && hints.destructiveHint !== false ? "high_impact" : "change";
  }
  // A bare read verb ("query", "status") says nothing about its object, so it waits whatever its description says.
  if (tokens?.length === 1 && READ_VERBS.has(tokens[0]) && hints.readOnlyHint !== true) return "unknown";
  if (closedReadName(tokens)) {
    if (hints.readOnlyHint === false) return "unknown";
    // WP-101 fix round 2, item E: a page, URL, file, path, shell or SQL name is only as safe as the arguments it is
    // given, and the approval request carries none. It waits, whatever its description or annotations say.
    if (argumentsDecide(tokens)) return "unknown";
    let onlySaid = said.replace(RUNS_A_READ, "_");
    if (objects?.size) onlySaid = withoutObjects(onlySaid, objects);
    return SAYS_HIGH_IMPACT.test(onlySaid) || changeInDescription.test(onlySaid) ? "unknown" : "read_only";
  }
  // A readOnlyHint is the server's own word, and a hostile server can say it about anything: it counts only when every
  // word of the name is one this module knows and none says a change, a join or a network word; and never when the
  // description says it changes something.
  if (hints.readOnlyHint === true && hintCanBeBelieved(tokens) && !SAYS_HIGH_IMPACT.test(said) && !changeInDescription.test(said))
    return "read_only";
  return SAYS_HIGH_IMPACT.test(said) ? "high_impact" : "unknown";
}

/** Whether a tool destroys, reaches other people, runs code, moves money or grants access, so it always waits. */
export function isHighImpactTool(toolName: string, description = "", hints: McpHints = {}): boolean {
  return toolEffect(toolName, description, hints) === "high_impact";
}
