import { cliLabel, isCli, isEffort } from "./clis";
import { firstMatch, type CrewRule } from "./rules";

export type FieldSource = "override" | "brief" | "rule" | "mono" | "project" | "system" | "default" | "none";

/** A CLI, model or effort from one place. Empty fields are unset, not a blank string. */
export type Pick = {
  cli?: string;
  model?: string;
  effort?: string;
};

/** WP-89: a default for one scope. Each field is optional, and a blank one is unset. */
export type RouteDefaults = {
  mono?: Pick;
  project?: Pick;
  system?: Pick;
  /** The app's usual model and effort, applied last. The usual CLI stays `defaultCli`. */
  usual?: Pick;
};

/** One model a CLI offers, and the efforts that model offers. */
export type CatalogModel = {
  id: string;
  name?: string;
  efforts: readonly string[];
};

/** Models by CLI. Absent: a model stays a free string and an effort stays the effort list. */
export type Catalog = Readonly<Record<string, readonly CatalogModel[]>>;

/** A model or effort a source set that this CLI's catalog doesn't offer. */
export type SkippedField = {
  field: "model" | "effort";
  from: FieldSource;
  value: string;
  reason: string;
};

export type Presence = {
  cli: string;
  installed: boolean;
  signedIn: boolean;
};

export type RouteTask = {
  labels: string[];
  paths: string[];
  override?: Pick;
  brief?: Pick;
};

export type Route = {
  cli: string | null;
  model: string | null;
  effort: string | null;
  cliFrom: FieldSource;
  modelFrom: FieldSource;
  effortFrom: FieldSource;
  /** Index into the merged rule list, when a rule matched. */
  ruleIndex: number | null;
  /** Models and efforts a source set that were skipped, in the order they were tried. */
  skipped: SkippedField[];
};

export type Role = "plan" | "verdict" | "work";

/**
 * Cheap models the catalog already names. Other CLIs keep their own model and
 * only drop to a low effort. ROMA's idea (a cheap model for planning and checks,
 * the routed model for the work); no ROMA text is included.
 */
const CHEAP_MODEL: Record<string, string> = {
  claude: "claude-haiku-4-5",
  opencode: "deepseek-v4-flash",
  fx: "zai/glm-5.2-fast",
};

function cleanModel(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return undefined;
  return text;
}

function field(value: string | undefined, kind: "cli" | "model" | "effort"): string | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (kind === "cli") return isCli(text) ? text : undefined;
  if (kind === "effort") return isEffort(text) ? text : undefined;
  return cleanModel(text);
}

type Kind = "cli" | "model" | "effort";

type Source = { from: FieldSource; pick?: Pick };

function rawOf(pick: Pick | undefined, kind: Kind): string | undefined {
  return pick?.[kind];
}

/**
 * Precedence, one field at a time: the person's override, then the brief, then
 * the first matching rule, then the Mono's default, the project's, the system's,
 * then the usual pick. A field a higher source leaves empty stays open for the
 * next source. The usual CLI is the signed-in default, not `usual.cli`.
 */
function sources(override: Pick | undefined, brief: Pick | undefined, rule: CrewRule | undefined, defaults: RouteDefaults | undefined): Source[] {
  return [
    { from: "override", pick: override },
    { from: "brief", pick: brief },
    { from: "rule", pick: rule },
    { from: "mono", pick: defaults?.mono },
    { from: "project", pick: defaults?.project },
    { from: "system", pick: defaults?.system },
  ];
}

function pickCli(rows: readonly Source[], present: readonly Presence[]): { value: string | undefined; from: FieldSource } {
  for (const row of rows) {
    const value = field(rawOf(row.pick, "cli"), "cli");
    if (value) return { value, from: row.from };
  }
  const fallback = defaultCli(present);
  return { value: fallback ?? undefined, from: fallback ? "default" : "none" };
}

function pickModel(
  rows: readonly Source[],
  usual: Pick | undefined,
  cli: string | undefined,
  catalog: Catalog | undefined,
  skipped: SkippedField[],
): { value: string | undefined; from: FieldSource } {
  const offers = cli && catalog ? catalog[cli] : undefined;
  const who = cli ? cliLabel(cli) : "The CLI";
  for (const row of [...rows, { from: "default" as const, pick: usual }]) {
    const value = field(rawOf(row.pick, "model"), "model");
    if (!value) continue;
    if (!catalog) return { value, from: row.from };
    if (offers?.some((model) => model.id === value)) return { value, from: row.from };
    skipped.push({ field: "model", from: row.from, value, reason: `${who} doesn't offer "${value}".` });
  }
  return { value: undefined, from: "none" };
}

function pickEffort(
  rows: readonly Source[],
  usual: Pick | undefined,
  model: CatalogModel | undefined,
  catalog: Catalog | undefined,
  skipped: SkippedField[],
): { value: string | undefined; from: FieldSource } {
  const name = model?.name || model?.id;
  for (const row of [...rows, { from: "default" as const, pick: usual }]) {
    const raw = rawOf(row.pick, "effort");
    const text = raw?.trim();
    if (!text || text.length > 200 || /[\r\n]/.test(text)) continue;
    if (!isEffort(text)) {
      if (catalog) skipped.push({ field: "effort", from: row.from, value: text, reason: `"${text}" isn't an effort.` });
      continue;
    }
    if (catalog && model && !model.efforts.includes(text)) {
      skipped.push({ field: "effort", from: row.from, value: text, reason: `${name} doesn't offer "${text}".` });
      continue;
    }
    return { value: text, from: row.from };
  }
  return { value: undefined, from: "none" };
}

/** Claude Code when it is installed and signed in, otherwise the first signed-in CLI in the given order. */
export function defaultCli(present: readonly Presence[]): string | null {
  const usable = present.filter((row) => row.installed && row.signedIn && isCli(row.cli));
  if (usable.some((row) => row.cli === "claude")) return "claude";
  return usable[0]?.cli ?? null;
}

export function defaultLine(present: readonly Presence[]): string {
  const cli = defaultCli(present);
  if (!cli) return "With nothing else set, work waits until a CLI is installed and signed in.";
  return `With nothing else set, work uses ${cliLabel(cli)}.`;
}

/**
 * Precedence, one field at a time. A model or effort the catalog doesn't offer
 * for the chosen CLI is skipped, with the reason, and the next source is tried.
 * With no catalog, a model stays a free string and an unknown effort is skipped
 * quietly, as before. Omit `options` and nothing below a rule changes.
 */
export function resolveRoute(
  task: RouteTask,
  rules: readonly CrewRule[],
  present: readonly Presence[],
  options?: { defaults?: RouteDefaults; catalog?: Catalog },
): Route {
  const ruleIndex = firstMatch(rules, task.labels, task.paths);
  const rule = ruleIndex == null ? undefined : rules[ruleIndex];
  const rows = sources(task.override, task.brief, rule, options?.defaults);
  const skipped: SkippedField[] = [];
  const cli = pickCli(rows, present);
  const model = pickModel(rows, options?.defaults?.usual, cli.value, options?.catalog, skipped);
  const chosen = cli.value && options?.catalog ? options.catalog[cli.value]?.find((row) => row.id === model.value) : undefined;
  const effort = pickEffort(rows, options?.defaults?.usual, chosen, options?.catalog, skipped);
  return {
    cli: cli.value ?? null,
    model: model.value ?? null,
    effort: effort.value ?? null,
    cliFrom: cli.value ? cli.from : "none",
    modelFrom: model.value ? model.from : "none",
    effortFrom: effort.value ? effort.from : "none",
    ruleIndex,
    skipped,
  };
}

/** Planning help and verdict checks use a cheap, fast model. The work uses the route. */
export function roleModel(role: Role, route: Route): { model: string | null; effort: string | null } {
  if (role === "work") return { model: route.model, effort: route.effort };
  return { model: route.cli ? (CHEAP_MODEL[route.cli] ?? null) : null, effort: "low" };
}
