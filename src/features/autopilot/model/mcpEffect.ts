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
 * What a tool does. Trusted in this order: a destructiveHint; a high-impact name; a change named as one (which its
 * description can still make high impact); a readOnlyHint; a read verb in the name; and only then the description.
 * A read-only hint never outweighs a name, and a description never outweighs either of them, except that a read whose
 * description says it changes something is unknown.
 */
export function toolEffect(toolName: string, description = "", hints: McpHints = {}): McpEffect {
  const name = sanitizeNameComponent(toolName);
  const said = sanitizeNameComponent(description);
  const objects = readObjects(name);
  if (hints.destructiveHint === true || (DESTRUCTIVE.test(name) && objects === null) || sensitiveChange(name, description))
    return "high_impact";
  if (BROWSER_READS.has(name)) return "read_only";
  if (BROWSER_SESSION_TOOLS.has(name)) return "change";
  if (changes(name)) {
    // Its description can make a change high impact, unless the server says it isn't destructive: words such as
    // "share" or "comment" in a description are often nouns.
    return SAYS_HIGH_IMPACT.test(said) && hints.destructiveHint !== false ? "high_impact" : "change";
  }
  if (hints.readOnlyHint === true) return "read_only";
  if (hints.readOnlyHint !== false && READ.test(name)) {
    let onlySaid = said.replace(RUNS_A_READ, "_");
    if (objects?.size) onlySaid = withoutObjects(onlySaid, objects);
    return SAYS_HIGH_IMPACT.test(onlySaid) || changeInDescription.test(onlySaid) ? "unknown" : "read_only";
  }
  return SAYS_HIGH_IMPACT.test(said) ? "high_impact" : "unknown";
}

/** Whether a tool destroys, reaches other people, runs code, moves money or grants access, so it always waits. */
export function isHighImpactTool(toolName: string, description = "", hints: McpHints = {}): boolean {
  return toolEffect(toolName, description, hints) === "high_impact";
}
