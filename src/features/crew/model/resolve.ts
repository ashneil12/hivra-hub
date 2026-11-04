import { cliLabel, isCli, isEffort } from "./clis";
import { firstMatch, type CrewRule } from "./rules";

export type FieldSource = "override" | "brief" | "rule" | "default" | "none";

/** A CLI, model or effort from one place. Empty fields are unset, not a blank string. */
export type Pick = {
  cli?: string;
  model?: string;
  effort?: string;
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

function pickField(
  kind: "cli" | "model" | "effort",
  override: Pick | undefined,
  brief: Pick | undefined,
  rule: CrewRule | undefined,
): { value: string | undefined; from: FieldSource } {
  const overrideValue = field(override?.[kind], kind);
  if (overrideValue) return { value: overrideValue, from: "override" };
  const briefValue = field(brief?.[kind], kind);
  if (briefValue) return { value: briefValue, from: "brief" };
  const ruleValue = field(rule?.[kind], kind);
  if (ruleValue) return { value: ruleValue, from: "rule" };
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
 * Precedence, one field at a time: the person's override, then the brief, then
 * the first matching rule, then the default CLI. A field a higher source leaves
 * empty stays open for the next source. An unknown CLI or effort is skipped.
 */
export function resolveRoute(task: RouteTask, rules: readonly CrewRule[], present: readonly Presence[]): Route {
  const ruleIndex = firstMatch(rules, task.labels, task.paths);
  const rule = ruleIndex == null ? undefined : rules[ruleIndex];
  const cli = pickField("cli", task.override, task.brief, rule);
  const model = pickField("model", task.override, task.brief, rule);
  const effort = pickField("effort", task.override, task.brief, rule);
  if (!cli.value) {
    const fallback = defaultCli(present);
    return {
      cli: fallback,
      model: model.value ?? null,
      effort: effort.value ?? null,
      cliFrom: fallback ? "default" : "none",
      modelFrom: model.value ? model.from : "none",
      effortFrom: effort.value ? effort.from : "none",
      ruleIndex,
    };
  }
  return {
    cli: cli.value,
    model: model.value ?? null,
    effort: effort.value ?? null,
    cliFrom: cli.from,
    modelFrom: model.value ? model.from : "none",
    effortFrom: effort.value ? effort.from : "none",
    ruleIndex,
  };
}

/** Planning help and verdict checks use a cheap, fast model. The work uses the route. */
export function roleModel(role: Role, route: Route): { model: string | null; effort: string | null } {
  if (role === "work") return { model: route.model, effort: route.effort };
  return { model: route.cli ? (CHEAP_MODEL[route.cli] ?? null) : null, effort: "low" };
}
