// WP-89: a plain model name ("opus", "grok 4") becomes a catalog id, and the sentence
// says what is in force. Nothing here writes. A value that isn't usable is refused
// without being repeated.

import { CLI_ORDER, cliLabel, isCli, isEffort } from "./clis";
import {
  resolveRoute,
  type Catalog,
  type CatalogModel,
  type FieldSource,
  type Pick,
  type Route,
  type RouteDefaults,
} from "./resolve";
import type { CrewRule } from "./rules";
import { cleanStoredDefault } from "./workerDefault";

export type Scope = "mono" | "project" | "system";

export type PlannedChoice = {
  scope: Scope;
  /** Absent when the scope is cleared. */
  pick?: Pick;
  /** Set when a stored effort no longer fits the model they just chose. */
  dropped?: string;
};

const SOURCE: Record<string, string> = {
  mono: "set for this Mono",
  project: "set for this project",
  system: "set for every worker",
  rule: "from a crew rule",
  override: "for this launch",
  brief: "from the brief",
};

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** A catalog name, without a leading "Claude " so the line says "Sonnet". */
export function modelDisplay(model: CatalogModel): string {
  return (model.name || model.id).replace(/^Claude\s+/i, "");
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function usable(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`The ${name} isn't usable.`);
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) throw new Error(`The ${name} isn't usable.`);
  return text;
}

function score(query: string, model: CatalogModel): number {
  const exact = norm(query);
  const words = tokens(query);
  if (!exact || words.length === 0) return 0;
  const id = norm(model.id);
  const name = model.name ? norm(model.name) : "";
  if (exact === id || exact === name) return 100;
  const bag = [...tokens(model.id), ...(model.name ? tokens(model.name) : [])];
  if (words.every((word) => bag.includes(word))) return 80;
  if (words.every((word) => bag.some((token) => token.startsWith(word)))) return 60;
  return 0;
}

type Hit = { cli: string; model: CatalogModel; score: number };

function lookup(query: string, catalog: Catalog, cli?: string): { cli: string; model: CatalogModel } {
  const clis = cli ? [cli] : Object.keys(catalog);
  const hits: Hit[] = [];
  for (const id of clis) {
    for (const model of catalog[id] ?? []) {
      const ranked = score(query, model);
      if (ranked) hits.push({ cli: id, model, score: ranked });
    }
  }
  const best = hits.reduce((max, hit) => Math.max(max, hit.score), 0);
  const top = hits.filter((hit) => hit.score === best);
  if (!top.length) {
    if (cli) {
      const names = (catalog[cli] ?? []).map(modelDisplay);
      throw new Error(
        `${cliLabel(cli)} doesn't offer "${query}". It offers ${names.length ? joinAnd(names) : "nothing"}.`,
      );
    }
    throw new Error(`No CLI offers "${query}".`);
  }
  const where = [...new Set(top.map((hit) => hit.cli))];
  if (!cli && where.length > 1) {
    throw new Error(
      `"${query}" is on more than one CLI: ${joinAnd(where.map(cliLabel))}. Say which CLI.`,
    );
  }
  const onOne = top.filter((hit) => hit.cli === where[0]);
  const models = [...new Map(onOne.map((hit) => [hit.model.id, hit.model])).values()];
  if (models.length > 1) {
    throw new Error(
      `"${query}" matches more than one ${cliLabel(where[0])} model: ${joinAnd(models.map(modelDisplay))}. Say which one.`,
    );
  }
  return { cli: where[0], model: models[0] };
}

function knownCli(value: unknown): string {
  const text = usable(value, "CLI");
  if (!isCli(text)) {
    throw new Error(`"${text}" isn't a CLI. The CLIs are ${joinAnd(CLI_ORDER.map(cliLabel))}.`);
  }
  return text;
}

function offered(catalog: Catalog, cli: string | undefined, model: string | undefined): CatalogModel | undefined {
  if (!cli || !model) return undefined;
  return catalog[cli]?.find((row) => row.id === model);
}

function effortFits(model: CatalogModel | undefined, effort: string): boolean {
  if (!model || model.efforts.length === 0) return isEffort(effort);
  return model.efforts.includes(effort);
}

function checkEffort(effort: string, model: CatalogModel | undefined): void {
  if (!isEffort(effort)) throw new Error(`"${effort}" isn't an effort.`);
  if (model && model.efforts.length > 0 && !model.efforts.includes(effort)) {
    throw new Error(
      `${modelDisplay(model)} doesn't offer "${effort}". It offers ${joinAnd([...model.efforts])}.`,
    );
  }
}

function scopeOf(value: unknown): Scope {
  if (value === "mono" || value === "project" || value === "system") return value;
  throw new Error('scope must be "mono", "project" or "system".');
}

/**
 * What a set or clear would store. `clear: true` wins over a model sent with it.
 * A project's effort needs a model, the one already stored or the one in this call.
 */
export function planWorkerChoice(
  input: { scope?: unknown; cli?: unknown; model?: unknown; effort?: unknown; clear?: unknown },
  current: Pick | undefined,
  catalog: Catalog,
): PlannedChoice {
  const naming = input.cli !== undefined || input.model !== undefined || input.effort !== undefined || input.clear !== undefined;
  if (naming && input.scope === undefined) {
    throw new Error("Say whether this is just this Mono, this project, or everything.");
  }
  const scope = scopeOf(input.scope);
  if (!naming) throw new Error("Say the model, or clear it.");
  if (input.clear !== undefined && input.clear !== true) throw new Error("clear must be true");
  if (input.clear === true) return { scope, pick: undefined };

  const stored = cleanStoredDefault(current) ?? {};
  let cli = stored.cli;
  let model = stored.model;
  let effort = stored.effort;
  let dropped: string | undefined;

  if (input.cli !== undefined) {
    cli = knownCli(input.cli);
    const still = offered(catalog, cli, model);
    if (model && input.model === undefined && !still) {
      dropped = `The old model isn't one ${cliLabel(cli)} offers, so it was dropped.`;
      model = undefined;
      effort = undefined;
    }
  }
  if (input.model !== undefined) {
    const asked = usable(input.model, "model");
    const found = lookup(asked, catalog, input.cli !== undefined ? cli : undefined);
    cli = found.cli;
    if (model && model !== found.model.id && input.effort === undefined && effort && !effortFits(found.model, effort)) {
      dropped = `The old ${effort} effort doesn't fit ${modelDisplay(found.model)}, so it was dropped.`;
      effort = undefined;
    }
    model = found.model.id;
  }
  if (input.effort !== undefined) {
    const asked = usable(input.effort, "effort");
    checkEffort(asked, offered(catalog, cli, model));
    effort = asked;
  }
  if (scope === "project" && !model) throw new Error("Say which model this project uses.");
  const pick = cleanStoredDefault({ cli, model, effort });
  return { scope, ...(pick ? { pick } : { pick: undefined }), ...(dropped ? { dropped } : {}) };
}

function phrase(from: FieldSource): string | undefined {
  return SOURCE[from];
}

function findModel(catalog: Catalog, cli: string | null, id: string | null): CatalogModel | undefined {
  if (!id) return undefined;
  if (cli && catalog[cli]) return catalog[cli].find((model) => model.id === id);
  for (const models of Object.values(catalog)) {
    const found = models.find((model) => model.id === id);
    if (found) return found;
  }
  return undefined;
}

export type InForce = {
  sentence: string;
  route: Route;
};

/** What a worker uses, field by field, and one sentence of it. */
export function describeInForce(input: {
  defaults?: RouteDefaults;
  catalog: Catalog;
  rules?: readonly CrewRule[];
}): InForce {
  const route: Route = resolveRoute(
    { labels: [], paths: [] },
    input.rules ?? [],
    [],
    { defaults: input.defaults, catalog: input.catalog },
  );
  return { sentence: sentenceFor(route, input.catalog), route };
}

/** One sentence of what a worker uses, and where each field came from. */
export function inForceSentence(input: { defaults?: RouteDefaults; catalog: Catalog; rules?: readonly CrewRule[] }): string {
  return describeInForce(input).sentence;
}

function sentenceFor(route: Route, catalog: Catalog): string {
  const model = findModel(catalog, route.cli, route.model);
  const modelName = route.model ? (model ? modelDisplay(model) : route.model) : undefined;
  const cliNamed = !!(route.cli && route.cli !== "claude" && route.cliFrom !== "none" && route.cliFrom !== "default");
  type Part = { text: string; from: FieldSource };
  const parts: Part[] = [];
  if (modelName) parts.push({ text: modelName, from: route.modelFrom });
  if (cliNamed && route.cli) {
    parts.push({ text: modelName ? `on ${cliLabel(route.cli)}` : cliLabel(route.cli), from: route.cliFrom });
  }
  if (route.effort) parts.push({ text: `at ${route.effort} effort`, from: route.effortFrom });
  let sentence: string;
  if (!parts.length) {
    sentence = "Its workers use the usual model.";
  } else {
    if (!modelName && !cliNamed) parts.unshift({ text: "the usual model", from: "default" });
    const chosen = parts.filter((part) => part.from !== "default" && part.from !== "none");
    const shared = chosen.length > 0 && chosen.every((part) => part.from === chosen[0].from);
    const body = parts.map((part) => part.text).join(" ");
    sentence =
      shared && phrase(chosen[0].from)
        ? `Its workers use ${body} (${phrase(chosen[0].from)}).`
        : `Its workers use ${parts
            .map((part) => (phrase(part.from) ? `${part.text} (${phrase(part.from)})` : part.text))
            .join(" ")}.`;
  }
  const skipped = route.skipped.map((row) => row.reason).filter(Boolean);
  return skipped.length ? `${sentence} ${skipped.join(" ")}` : sentence;
}

/** A second sentence when a crew rule still sends some labels or paths elsewhere. */
export function crewRuleSentence(rules: readonly CrewRule[], catalog: Catalog): string {
  const notes: string[] = [];
  for (const rule of rules) {
    const where = rule.labels[0] ?? rule.paths[0];
    if (!where) continue;
    const model = rule.model ? findModel(catalog, rule.cli ?? null, rule.model) : undefined;
    const name = rule.model ? (model ? modelDisplay(model) : rule.model) : rule.cli ? cliLabel(rule.cli) : "";
    if (!name) continue;
    notes.push(`\`${where}\` work to ${name}`);
    if (notes.length >= 3) break;
  }
  if (!notes.length) return "";
  return `Crew rules still send ${joinAnd(notes)}.`;
}

export function scopeClearLine(scope: Scope): string {
  if (scope === "mono") return "Cleared the Mono's worker default.";
  if (scope === "project") return "Cleared this project's worker default.";
  return "Cleared the default for every worker.";
}
