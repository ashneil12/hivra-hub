// PT-1: the proof-tool catalogue. One data file, proofTools.json, read here and compiled into Rust
// (src-tauri/src/proof_tools/catalogue.rs, `include_str!`), so the two sides never disagree about which tools exist, what
// each one proves and how the app tells a project already has it. The app never installs a tool into a person's project:
// `install` is what a worker the person agreed to would run, and it is only shown in a proposal.
import catalogue from "./proofTools.json";

export type ProofToolKind = "property" | "mutation" | "e2e" | "api" | "pattern";
export type ProofToolStack = "node" | "rust" | "python" | "openapi" | "web";

/** How a tool fits a project, or how the app tells the project already has it. Evaluated in Rust (`detect.rs`). */
export type ProofToolRule =
  | { stack: ProofToolStack }
  | { anyOf: ProofToolRule[] }
  | { allOf: ProofToolRule[] }
  | { npmDep: string }
  | { npmDepPrefix: string }
  | { cargoDevDep: string }
  | { pyDep: string }
  | { file: string }
  | { filePrefix: string }
  | { anyFileSuffix: string }
  | { dir: string }
  | { binary: string[] };

export type ProofToolCompanion = { name: string; repo: string; pinned: string };

export type ProofTool = {
  id: string;
  name: string;
  /** The tool's source, https. */
  repo: string;
  /** SPDX. */
  licence: string;
  /** One plain line a person reads. */
  proves: string;
  /** One sentence on how a worker uses it in a task. */
  howToUse: string;
  stacks: ProofToolStack[];
  detect: ProofToolRule;
  installed: ProofToolRule;
  /** What a worker the person agreed to would run. Shown in a proposal; never run by the app. */
  install: string;
  /** The command with `{files} {ranges} {diff} {base} {schema} {baseUrl} {config} {out}` filled by the app. Null for a property library: it has no runner of its own, its properties run with the project's tests. */
  run: string | null;
  /** More commands run after `run`. */
  runAlso?: string[];
  needsModel: boolean;
  /** The version this was checked against. */
  pinned: string;
  kind: ProofToolKind;
  /** Run only if the person already has it: never bundled, copied or installed by the app (Semgrep). */
  external: boolean;
  also?: ProofToolCompanion[];
};

export const KNOWN_LICENCES = ["MIT", "Apache-2.0", "MIT OR Apache-2.0", "MPL-2.0", "BSD-3-Clause", "LGPL-2.1-or-later"] as const;
const KINDS: readonly string[] = ["property", "mutation", "e2e", "api", "pattern"];
const STACKS: readonly string[] = ["node", "rust", "python", "openapi", "web"];
const PLACEHOLDERS = ["files", "ranges", "diff", "base", "schema", "baseUrl", "config", "out"];

const TOOLS_MAX = 64;
const TEXT_MAX = 400;
const RULE_DEPTH_MAX = 6;
const LITERAL_WORD = /^[A-Za-z0-9_@./:=+,-]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A proposal's decision key starts with this (`proof-tools/fast-check`), the same words as Rust's `DECISION_PREFIX`. */
export const PROPOSAL_KEY_PREFIX = "proof-tools/";
/** The two answers a proposal offers, in the words the person sees. */
export const ANSWER_ADD = "Add it";
export const ANSWER_NOT_NOW = "Not now";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasControl(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function text(entry: Record<string, unknown>, key: string, at: string): string {
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at}: ${key} is missing or empty`);
  if (value.trim().length > TEXT_MAX || hasControl(value)) throw new Error(`${at}: ${key} is too long or has a control character`);
  return value;
}

function flag(entry: Record<string, unknown>, key: string, at: string): boolean {
  const value = entry[key];
  if (typeof value !== "boolean") throw new Error(`${at}: ${key} must be true or false`);
  return value;
}

function https(value: string, what: string, at: string): void {
  if (!value.startsWith("https://") || /\s/.test(value)) throw new Error(`${at}: ${what} is not an https address`);
}

/**
 * A name a rule compares with. A package name (`@fast-check/vitest`) has a `/` and an `@`; a file or folder name is one
 * path part and never has a separator or `..`.
 */
function ruleName(name: unknown, at: string, kind: "package" | "path"): string {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 80 ||
    name.includes("..") ||
    /\s/.test(name) ||
    hasControl(name) ||
    (kind === "path" ? /[/\\]/.test(name) : name.includes("\\"))
  )
    throw new Error(`${at}: a rule has a name the app won't compare with`);
  return name;
}

function readRule(raw: unknown, stacks: readonly string[], at: string, depth = 0): ProofToolRule {
  if (depth > RULE_DEPTH_MAX) throw new Error(`${at}: a rule is nested too deep`);
  const rule = record(raw);
  const keys = rule ? Object.keys(rule) : [];
  if (!rule || keys.length !== 1) throw new Error(`${at}: a rule must have exactly one key`);
  const key = keys[0];
  const value = rule[key];
  switch (key) {
    case "stack":
      if (typeof value !== "string" || !STACKS.includes(value)) throw new Error(`${at}: a rule names a stack that doesn't exist`);
      if (!stacks.includes(value)) throw new Error(`${at}: a rule names the ${value} stack the tool doesn't list`);
      return { stack: value as ProofToolStack };
    case "anyOf":
    case "allOf": {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${at}: a rule lists nothing`);
      const rules = value.map((item) => readRule(item, stacks, at, depth + 1));
      return key === "anyOf" ? { anyOf: rules } : { allOf: rules };
    }
    case "npmDep":
      return { npmDep: ruleName(value, at, "package") };
    case "npmDepPrefix":
      return { npmDepPrefix: ruleName(value, at, "package") };
    case "cargoDevDep":
      return { cargoDevDep: ruleName(value, at, "package") };
    case "pyDep":
      return { pyDep: ruleName(value, at, "package") };
    case "file":
      return { file: ruleName(value, at, "path") };
    case "filePrefix":
      return { filePrefix: ruleName(value, at, "path") };
    case "anyFileSuffix":
      return { anyFileSuffix: ruleName(value, at, "path") };
    case "dir":
      return { dir: ruleName(value, at, "path") };
    case "binary": {
      if (
        !Array.isArray(value) ||
        value.length < 2 ||
        value.length > 4 ||
        value[value.length - 1] !== "--version" ||
        value.some((word) => typeof word !== "string" || !LITERAL_WORD.test(word))
      )
        throw new Error(`${at}: a binary rule must be a plain argv ending --version`);
      return { binary: value as string[] };
    }
    default:
      throw new Error(`${at}: a rule of an unknown kind (${key.slice(0, 40)})`);
  }
}

/** A command template: fixed words, and the app's own placeholders. Nothing a shell reads as an operator. */
function checkTemplate(template: unknown, at: string): string {
  if (typeof template !== "string" || !template.trim() || template.length > 300) throw new Error(`${at}: a command is empty or too long`);
  const bare = PLACEHOLDERS.reduce((rest, name) => rest.split(`{${name}}`).join("x"), template);
  if (!/^[A-Za-z0-9_@./:=+," -]+$/.test(bare) || bare.includes("  ") || (bare.match(/"/g) ?? []).length % 2 !== 0)
    throw new Error(`${at}: a command has a character or a placeholder the app doesn't fill`);
  return template;
}

function readTool(raw: unknown, index: number): ProofTool {
  const entry = record(raw);
  const at = typeof entry?.id === "string" ? entry.id : `tool ${index + 1}`;
  if (!entry) throw new Error(`${at}: not an object`);
  const id = text(entry, "id", at);
  if (id.length > 40 || !SLUG.test(id)) throw new Error(`${at}: the id is not a short lower-case slug`);
  const repo = text(entry, "repo", at);
  https(repo, "repo", at);
  const licence = text(entry, "licence", at);
  if (!(KNOWN_LICENCES as readonly string[]).includes(licence)) throw new Error(`${at}: licence ${licence} is not one the catalogue knows`);
  const kind = text(entry, "kind", at);
  if (!KINDS.includes(kind)) throw new Error(`${at}: ${kind} is not a kind of tool`);
  const stacks = entry.stacks;
  if (!Array.isArray(stacks) || stacks.length === 0 || stacks.some((stack) => typeof stack !== "string" || !STACKS.includes(stack)))
    throw new Error(`${at}: stacks must list at least one known stack`);
  if (!("run" in entry)) throw new Error(`${at}: run is missing (a command, or null for a property library)`);
  const run = entry.run;
  if (run !== null && typeof run !== "string") throw new Error(`${at}: run must be a command or null`);
  if ((run === null) !== (kind === "property")) throw new Error(`${at}: only a property library has no run command, and it has no other`);
  const runAlso = entry.runAlso;
  if (runAlso !== undefined && (!Array.isArray(runAlso) || run === null))
    throw new Error(`${at}: runAlso is a list of commands that follow a run command`);
  const also = entry.also;
  if (also !== undefined && !Array.isArray(also)) throw new Error(`${at}: also must be a list`);
  const tool: ProofTool = {
    id,
    name: text(entry, "name", at),
    repo,
    licence,
    proves: text(entry, "proves", at),
    howToUse: text(entry, "howToUse", at),
    stacks: stacks as ProofToolStack[],
    detect: readRule(entry.detect, stacks as string[], at),
    installed: readRule(entry.installed, stacks as string[], at),
    install: text(entry, "install", at),
    run: typeof run === "string" ? checkTemplate(run, at) : null,
    needsModel: flag(entry, "needsModel", at),
    pinned: text(entry, "pinned", at),
    kind: kind as ProofToolKind,
    external: flag(entry, "external", at),
  };
  if (Array.isArray(runAlso)) tool.runAlso = runAlso.map((command: unknown) => checkTemplate(command, at));
  if (Array.isArray(also)) {
    tool.also = also.map((item: unknown) => {
      const companion = record(item);
      if (!companion) throw new Error(`${at}: a companion is not an object`);
      const out = { name: text(companion, "name", at), repo: text(companion, "repo", at), pinned: text(companion, "pinned", at) };
      https(out.repo, "a companion's repo", at);
      return out;
    });
  }
  return tool;
}

/**
 * The tools in a catalogue file, checked the way Rust checks them. A file with any entry that isn't right is refused whole
 * (this throws): a half-read catalogue never reaches a proposal or a brief.
 */
export function readCatalogue(raw: unknown): ProofTool[] {
  const file = record(raw);
  if (!file || file.version !== 1) throw new Error("the catalogue is not a version this build can read");
  const list = file.tools;
  if (!Array.isArray(list) || list.length === 0 || list.length > TOOLS_MAX) throw new Error("the catalogue lists no tools, or too many");
  const seen = new Set<string>();
  return list.map((item, index) => {
    const tool = readTool(item, index);
    if (seen.has(tool.id)) throw new Error(`${tool.id}: listed twice`);
    seen.add(tool.id);
    return tool;
  });
}

/** Every tool in the catalogue, in the catalogue's order. */
export const PROOF_TOOLS: readonly ProofTool[] = readCatalogue(catalogue);

export function findProofTool(id: string): ProofTool | undefined {
  return PROOF_TOOLS.find((tool) => tool.id === id);
}

/** The decision key a proposal is filed under: stable, so asking twice never asks twice. */
export function proposalKey(tool: Pick<ProofTool, "id">): string {
  return `${PROPOSAL_KEY_PREFIX}${tool.id}`;
}

/**
 * The question a first mate's proposal puts to the person: "Add <name> to catch <proves, lowercased>?". The first letter is
 * lowercased unless the word is an acronym (`API`), and the closing full stop goes. The same words as Rust's `Tool::question`.
 */
export function proposalQuestion(tool: Pick<ProofTool, "name" | "proves">): string {
  const proves = tool.proves.trim().replace(/\.+$/, "");
  const chars = Array.from(proves);
  const keep = chars.length >= 2 && /^\p{Uppercase}$/u.test(chars[1]);
  const lowered = keep || chars.length === 0 ? proves : chars[0].toLowerCase() + chars.slice(1).join("");
  return `Add ${tool.name} to catch ${lowered}?`;
}

// ---- what the app says a project has --------------------------------------------------------------------------------

export type ProofToolStatus = "open" | "proposed" | "declined";

/** One tool that fits a project (`proof_tools_list`). The words are the catalogue's, never the payload's. */
export type ProofToolView = {
  id: string;
  name: string;
  proves: string;
  howToUse: string;
  kind: ProofToolKind;
  external: boolean;
  /** The project already has it. */
  installed: boolean;
  /** Whether it has been proposed to the person (once per project) and what they said. Only meaningful when not installed. */
  status: ProofToolStatus;
};

export type ProofToolList = { stacks: ProofToolStack[]; tools: ProofToolView[] };

/**
 * What `proof_tools_list` answers, read defensively. A wrong shape is null. An entry whose id isn't in the catalogue, whose
 * kind or status isn't known or whose flags aren't flags is dropped, and so is a repeat; the text of an entry is always the
 * catalogue's own, so nothing a payload carries can reach a brief or a proposal.
 */
export function readProofToolList(payload: unknown): ProofToolList | null {
  const list = record(payload);
  if (!list || !Array.isArray(list.stacks) || !Array.isArray(list.tools)) return null;
  const stacks: ProofToolStack[] = [];
  for (const stack of list.stacks.slice(0, 20)) {
    if (typeof stack === "string" && STACKS.includes(stack) && !stacks.includes(stack as ProofToolStack)) stacks.push(stack as ProofToolStack);
  }
  const tools: ProofToolView[] = [];
  for (const item of list.tools.slice(0, TOOLS_MAX)) {
    const view = record(item);
    if (!view || typeof view.id !== "string") continue;
    const known = findProofTool(view.id);
    if (!known || tools.some((tool) => tool.id === known.id)) continue;
    if (typeof view.installed !== "boolean") continue;
    if (typeof view.kind !== "string" || view.kind !== known.kind) continue;
    if (view.status !== "open" && view.status !== "proposed" && view.status !== "declined") continue;
    if (view.external !== undefined && typeof view.external !== "boolean") continue;
    tools.push({
      id: known.id,
      name: known.name,
      proves: known.proves,
      howToUse: known.howToUse,
      kind: known.kind,
      external: known.external,
      installed: view.installed,
      status: view.status,
    });
  }
  // The catalogue's order, whatever order the app listed them in.
  tools.sort((a, b) => PROOF_TOOLS.findIndex((tool) => tool.id === a.id) - PROOF_TOOLS.findIndex((tool) => tool.id === b.id));
  return { stacks, tools };
}

// ---- the brief ------------------------------------------------------------------------------------------------------

/** One line of a brief's "Proof tools here" section: an installed tool, what it proves and how to use it in the task. */
export type ProofToolLine = { name: string; proves: string; use: string };

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The tools the project already has, in the catalogue's order. None installed (or no list): none. */
export function proofToolLines(list: ProofToolList | null | undefined): ProofToolLine[] {
  if (!list) return [];
  return list.tools
    .filter((tool) => tool.installed)
    .map((tool) => ({ name: tool.name, proves: tool.proves, use: tool.howToUse }));
}

export const PROOF_TOOLS_HEADING = "## Proof tools here";

/** The brief's short section naming each installed tool by name with its `proves` line and how to use it. None: no section. */
export function proofToolsSection(lines: readonly ProofToolLine[] | undefined): string | undefined {
  if (!lines?.length) return undefined;
  return [PROOF_TOOLS_HEADING, ...lines.map((line) => `- ${oneLine(line.name)}: ${oneLine(line.proves)} ${oneLine(line.use)}`)].join("\n");
}
