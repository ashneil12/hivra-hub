import { isCli, isEffort } from "./clis";

/** One ordered rule. A plugin's rules sit under the person's and are not editable here. */
export type CrewRule = {
  labels: string[];
  paths: string[];
  cli?: string;
  model?: string;
  effort?: string;
  /** WP-176. Measured-cost cap for a billed run, in dollars. Off when omitted. A plugin cannot set one. */
  taskCeilingUsd?: number;
  source: "person" | "plugin";
};

export type RuleDraft = {
  labels: string;
  paths: string;
  cli: string;
  model: string;
  effort: string;
  /** Blank means no ceiling. A number of dollars when set. */
  ceiling?: string;
};

const MAX_RULES = 40;
const MAX_ITEMS = 32;
const MAX_ITEM = 200;
const MAX_MODEL = 200;
const MAX_CEILING_USD = 1_000_000_000;
const MICRO = 1_000_000;

/** Split on `/` and `\\`, drop empty and `.`, and refuse `..` so a rule can't point outside. */
export function pathSegments(path: string): string[] | null {
  const text = path.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "");
  const parts = text.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  return parts;
}

/** A task path matches a rule path when it is that path or a file inside it. Lexical only. */
export function pathMatches(taskPath: string, rulePath: string): boolean {
  const task = pathSegments(taskPath);
  const rule = pathSegments(rulePath);
  if (!task || !rule || task.length === 0 || rule.length === 0) return false;
  if (task.length < rule.length) return false;
  return rule.every((segment, index) => segment === task[index]);
}

export function normLabel(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim().toLowerCase();
}

function cleanList(values: readonly string[], label: boolean): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = label ? normLabel(value) : value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim();
    if (!text || text.length > MAX_ITEM) continue;
    if (!label && pathSegments(text) === null) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function cleanModel(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_MODEL || /[\r\n]/.test(text)) return undefined;
  return text;
}

/** A blank ceiling is off. Anything else is a positive dollar amount, or refused. */
export function parseCeilingUsd(text: string): number | null | "bad" {
  const trimmed = text.replace(/\r\n/g, "").trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return "bad";
  return ceilingUsd(Number(trimmed));
}

function ceilingUsd(value: number): number | "bad" {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_CEILING_USD) return "bad";
  const micros = Math.round(value * MICRO);
  if (!Number.isSafeInteger(micros) || micros <= 0) return "bad";
  return micros / MICRO;
}

/** A stored or imported rule is untrusted. A broken one is dropped, not thrown. */
export function sanitizeRule(value: unknown, source: CrewRule["source"]): CrewRule | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const labels = Array.isArray(raw.labels) ? cleanList(raw.labels.filter((v) => typeof v === "string"), true) : [];
  const paths = Array.isArray(raw.paths) ? cleanList(raw.paths.filter((v) => typeof v === "string"), false) : [];
  if (labels.length === 0 && paths.length === 0) return null;
  const cli = typeof raw.cli === "string" && isCli(raw.cli.trim()) ? raw.cli.trim() : undefined;
  const effort = typeof raw.effort === "string" && isEffort(raw.effort.trim()) ? raw.effort.trim() : undefined;
  const model = cleanModel(typeof raw.model === "string" ? raw.model : undefined);
  if (!cli && !model && !effort) return null;
  let taskCeilingUsd: number | undefined;
  if (raw.taskCeilingUsd != null && source !== "plugin") {
    if (typeof raw.taskCeilingUsd !== "number") return null;
    const ceiling = ceilingUsd(raw.taskCeilingUsd);
    if (ceiling === "bad") return null;
    taskCeilingUsd = ceiling;
  }
  return { labels, paths, cli, model, effort, ...(taskCeilingUsd != null ? { taskCeilingUsd } : {}), source };
}

/** What the editor is willing to add. A sentence when it isn't a rule yet. */
export function draftRule(draft: RuleDraft): CrewRule | string {
  const labels = cleanList(draft.labels.split(/[,\n]/), true);
  const paths = cleanList(draft.paths.split(/[,\n]/), false);
  if (labels.length === 0 && paths.length === 0) return "Give a label or a path.";
  const cli = draft.cli.trim();
  const effort = draft.effort.trim();
  const model = cleanModel(draft.model);
  if (cli && !isCli(cli)) return "That isn't an agent CLI Hivra drives.";
  if (effort && !isEffort(effort)) return "That isn't an effort level.";
  if (draft.model.trim() && !model) return "The model has to be one line.";
  if (!cli && !model && !effort) return "Pick a CLI, a model or an effort.";
  const ceiling = parseCeilingUsd(draft.ceiling ?? "");
  if (ceiling === "bad") return "The task ceiling has to be a positive amount.";
  return {
    labels,
    paths,
    cli: cli || undefined,
    model,
    effort: effort || undefined,
    ...(ceiling != null ? { taskCeilingUsd: ceiling } : {}),
    source: "person",
  };
}

/** The lowest ceiling a person's rules set. A plugin rule cannot set one. None means leave the project alone. */
export function taskCeilingFromRules(rules: readonly CrewRule[]): number | null {
  let lowest: number | null = null;
  for (const rule of rules) {
    if (rule.source === "plugin" || rule.taskCeilingUsd == null) continue;
    const ceiling = ceilingUsd(rule.taskCeilingUsd);
    if (ceiling === "bad") continue;
    if (lowest == null || ceiling < lowest) lowest = ceiling;
  }
  return lowest;
}

/**
 * A rule matches when every dimension it sets hits. Labels are case-insensitive;
 * paths are case-sensitive segments. Empty task labels and paths match nothing.
 */
export function ruleMatches(rule: CrewRule, labels: readonly string[], paths: readonly string[]): boolean {
  const wanted = cleanList(labels, true);
  const files = paths.map((path) => path.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim()).filter(Boolean);
  if (wanted.length === 0 && files.length === 0) return false;
  if (rule.labels.length > 0 && !rule.labels.some((label) => wanted.includes(label))) return false;
  if (rule.paths.length > 0 && !rule.paths.some((rulePath) => files.some((file) => pathMatches(file, rulePath)))) {
    return false;
  }
  return rule.labels.length > 0 || rule.paths.length > 0;
}

/** Person's Mono rules, then the project's, then enabled plugin rules. First match wins. */
export function mergeRules(mono: readonly CrewRule[], project: readonly CrewRule[], plugins: readonly CrewRule[]): CrewRule[] {
  const merged = [
    ...mono.map((rule) => ({ ...rule, source: "person" as const })),
    ...project.map((rule) => ({ ...rule, source: "person" as const })),
    ...plugins.map((rule) => ({ ...rule, source: "plugin" as const })),
  ];
  return merged.slice(0, MAX_RULES);
}

export function firstMatch(rules: readonly CrewRule[], labels: readonly string[], paths: readonly string[]): number | null {
  const index = rules.findIndex((rule) => ruleMatches(rule, labels, paths));
  return index < 0 ? null : index;
}

export function moveRule<T>(rules: readonly T[], index: number, direction: -1 | 1): T[] {
  const next = index + direction;
  if (index < 0 || next < 0 || index >= rules.length || next >= rules.length) return [...rules];
  const copy = [...rules];
  const [row] = copy.splice(index, 1);
  copy.splice(next, 0, row);
  return copy;
}
