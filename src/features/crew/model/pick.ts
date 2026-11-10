// WP-141: the first mate's pick across CLIs and Monos. One helper, no second router.
// Presence, the roster and the caps are handed in, so a test does not need this machine.

import { cliLabel, isCli, isEffort } from "./clis";
import { isRoleSlot, roleSlotName, sanitizePolicy, type CrewPolicy } from "./policy";
import { resolveRoute, type Catalog, type Pick as RoutePick, type Presence, type RouteDefaults } from "./resolve";
import { firstMatch, type CrewRule } from "./rules";
import { crewRows, type CrewWorkerInput } from "./rows";

/** How deep a further Mono may sit. A brief at depth 2 would be the third Mono, and that is refused. */
export const MAX_MONO_DEPTH = 2;

export type MonoCandidate = {
  id: string;
  name?: string;
  /** The Mono's own role words, matched like a crew label. */
  role?: string;
  depth?: number;
};

export type PickInput = {
  labels?: readonly string[];
  paths?: readonly string[];
  rules?: readonly CrewRule[];
  present?: readonly Presence[];
  catalog?: Catalog;
  policy?: CrewPolicy;
  defaults?: RouteDefaults;
  monos?: readonly MonoCandidate[];
  /** The Mono leading this chat. It is not a candidate for its own brief. */
  leadMonoId?: string;
  /** Nesting depth of this chat. A CLI is still allowed at depth 2. Depth 3 refuses another Mono. */
  depth?: number;
  /** CLIs paused on quota, and ids already at the project worker cap. */
  pausedClis?: readonly string[];
  atCap?: readonly string[];
  /** The first mate's per-task override. Ignored when Always use my default is on. */
  override?: RoutePick & { monoId?: string };
  /** The person's own pick. It still applies when the lock is on. */
  brief?: RoutePick & { monoId?: string };
};

export type MatePick = {
  ok: boolean;
  cli: string | null;
  monoId: string | null;
  model: string | null;
  effort: string | null;
  reason: string;
};

type Kind = "cli" | "mono";

type Choice = {
  kind: Kind;
  id: string;
  name: string;
  role: number;
  roleWord: string;
  available: number;
  fallbackRank: number;
  defaultRank: number;
  stable: number;
};

function norm(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim().toLowerCase();
}

function banned(policy: CrewPolicy | undefined, id: string): boolean {
  return !!policy?.neverUse.includes(id);
}

function monoName(mono: MonoCandidate): string {
  const name = mono.name?.replace(/[\r\n]/g, " ").trim();
  return name || mono.id;
}

function roleTitle(label: string | undefined): string {
  const text = norm(label ?? "");
  if (!text) return "This";
  if (isRoleSlot(text)) return roleSlotName(text);
  return label?.trim() || "This";
}

function depthSentence(depth: number): string {
  const word = depth >= 3 ? "three" : "two";
  return `This chat is already ${word} Monos deep, so another Mono was refused.`;
}

function none(reason: string): MatePick {
  return { ok: false, cli: null, monoId: null, model: null, effort: null, reason };
}

function cliResult(id: string, model: string | null, effort: string | null, reason: string): MatePick {
  return { ok: true, cli: id, monoId: null, model, effort, reason };
}

function monoResult(id: string, reason: string): MatePick {
  return { ok: true, cli: null, monoId: id, model: null, effort: null, reason };
}

function cleanModel(value: string | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return null;
  return text;
}

function cleanEffort(value: string | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  return isEffort(text) ? text : null;
}

function cleanMonoId(value: string | undefined): string | null {
  if (value == null || /[\r\n]/.test(value)) return null;
  const text = value.trim();
  if (!text || text.length > 64 || text.includes("..") || text.includes("/") || text.includes("\\")) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  return text;
}

function fieldsFor(input: PickInput, cli: string): { model: string | null; effort: string | null } {
  const route = resolveRoute(
    { labels: [...(input.labels ?? [])], paths: [...(input.paths ?? [])] },
    input.rules ?? [],
    input.present ?? [],
    { defaults: input.defaults, catalog: input.catalog, policy: input.policy },
  );
  if (route.cli !== cli) return { model: null, effort: null };
  return { model: route.model, effort: route.effort };
}

/**
 * The worker for this brief. A Mono is refused at depth 3. The reason is never empty.
 * The first mate's override is used only when Always use my default is off.
 */
const LOCK_REASON = "Always use my default is on, so this override was not applied.";

type Ask = RoutePick & { monoId?: string };

function hasAsk(ask: Ask | undefined): boolean {
  if (!ask) return false;
  return Boolean(ask.cli?.trim() || ask.model?.trim() || ask.effort?.trim() || ask.monoId?.trim());
}

function banSentence(id: string): string {
  return isCli(id) ? `${cliLabel(id)} is on Never use, so it was skipped.` : `${id} is on Never use, so it was skipped.`;
}

export function pickMate(raw: PickInput): MatePick {
  const policy = raw.policy ? sanitizePolicy(raw.policy) : undefined;
  const input: PickInput = { ...raw, ...(policy ? { policy } : {}) };
  const labels = input.labels ?? [];
  const paths = input.paths ?? [];
  const rules = input.rules ?? [];
  const present = input.present ?? [];
  const depth = input.depth ?? 0;
  const paused = new Set(input.pausedClis ?? []);
  const capped = new Set(input.atCap ?? []);
  const clis = present.filter((row) => row.installed && row.signedIn && isCli(row.cli) && !banned(policy, row.cli));
  const monoAllowed = depth < MAX_MONO_DEPTH;
  // With Always use my default on, the pick is the default CLI alone: no Mono is offered.
  const lock = policy?.lockDefault === true;
  const roster = (input.monos ?? []).map((mono) => {
    const id = cleanMonoId(mono?.id);
    return id ? { ...mono, id } : undefined;
  }).filter((mono): mono is MonoCandidate => !!mono);
  const monos = roster.filter((mono) => {
    if (lock) return false;
    if (!monoAllowed) return false;
    if ((mono.depth ?? 0) >= MAX_MONO_DEPTH) return false;
    if (input.leadMonoId && mono.id === input.leadMonoId) return false;
    if (banned(policy, mono.id)) return false;
    return true;
  });

  const wanted = labels.map(norm).filter(Boolean);
  const index = firstMatch(rules, [...labels], [...paths]);
  const matched = index == null ? undefined : rules[index];
  const roleCli = matched?.cli && isCli(matched.cli) && !banned(policy, matched.cli) ? matched.cli : undefined;
  const roleName = roleTitle(matched?.labels[0]);
  const fallback = policy?.fallback ?? [];
  const usual = clis.some((row) => row.cli === "claude") ? "claude" : clis[0]?.cli;
  // The CLI the person set (a rule, or a Mono, project or system default). It ranks under a role match and above the
  // fallback order, and with Always use my default on it is the only CLI the pick may use.
  const setCli = personSetCli(input);

  const choices: Choice[] = [];
  clis.forEach((row, stable) => {
    const rank = fallback.indexOf(row.cli);
    choices.push({
      kind: "cli",
      id: row.cli,
      name: cliLabel(row.cli),
      role: roleCli === row.cli ? 2 : setCli === row.cli ? 1 : 0,
      roleWord: roleName,
      available: paused.has(row.cli) || capped.has(row.cli) ? 0 : 1,
      fallbackRank: rank >= 0 ? rank : 1000,
      defaultRank: row.cli === usual ? 1 : 0,
      stable,
    });
  });
  monos.forEach((mono, at) => {
    const role = norm(mono.role ?? "");
    choices.push({
      kind: "mono",
      id: mono.id,
      name: monoName(mono),
      role: role.length > 0 && wanted.includes(role) ? 2 : 0,
      roleWord: role,
      available: capped.has(mono.id) ? 0 : 1,
      fallbackRank: 2000 + at,
      defaultRank: 0,
      stable: clis.length + at,
    });
  });

  const override = input.override;
  const overrideSet = hasAsk(override);
  const asked = lock ? input.brief : overrideSet ? override : input.brief ?? override;
  const skipped = bannedTarget(policy, lock ? undefined : override) ?? bannedTarget(policy, matched?.cli ? { cli: matched.cli } : undefined);
  const explicit = takeAsk(asked, roster, clis, input.leadMonoId, monoAllowed, policy);
  if (explicit.kind === "depth") return stamp(lock && overrideSet, none(depthSentence(depth)));
  if (explicit.kind === "mono") return stamp(lock && overrideSet, monoResult(explicit.id, `This task asks for ${explicit.name}.`));
  if (explicit.kind === "cli") {
    const fields = fieldsFor(input, explicit.id);
    return stamp(
      lock && overrideSet,
      cliResult(explicit.id, cleanModel(asked?.model) ?? fields.model, cleanEffort(asked?.effort) ?? fields.effort, `This task asks for ${cliLabel(explicit.id)}.`),
    );
  }

  if (lock) {
    // The CLI the person set, else the signed-in default (Claude Code first). Never the fallback order.
    const target = setCli ?? usual;
    if (!target) return stamp(overrideSet, none(note(skipped, "Always use my default is on, and no CLI is signed in, so nothing was picked.")));
    const mine = choices.find((choice) => choice.kind === "cli" && choice.id === target);
    if (!mine || mine.available !== 1) {
      const name = cliLabel(target);
      const why = paused.has(target)
        ? `${name} is at its quota and Always use my default is on, so nothing else was picked.`
        : `${name} is not free and Always use my default is on, so nothing else was picked.`;
      return stamp(overrideSet, none(note(skipped, why)));
    }
    return stamp(overrideSet, finish(input, { kind: "cli", id: mine.id, reason: defaultOrRole(mine) }, note(skipped, defaultOrRole(mine))));
  }
  const picked = choose(choices, roleCli ?? setCli, paused);
  const hadMono = roster.length > 0;
  if (!picked) return stamp(lock && overrideSet, none(note(skipped, nothingReason(depth, hadMono))));
  return stamp(lock && overrideSet, finish(input, picked, note(skipped, picked.reason)));
}

function stamp(lock: boolean, pick: MatePick): MatePick {
  if (!lock) return pick;
  return { ...pick, reason: `${LOCK_REASON} ${pick.reason}` };
}

function note(skipped: string | undefined, reason: string): string {
  if (!skipped) return reason;
  return `${banSentence(skipped)} ${reason}`;
}

function bannedTarget(policy: CrewPolicy | undefined, ask: Ask | undefined): string | undefined {
  const mono = cleanMonoId(ask?.monoId);
  if (mono && banned(policy, mono)) return mono;
  const cli = ask?.cli?.trim();
  if (cli && isCli(cli) && banned(policy, cli)) return cli;
  return undefined;
}

type Taken =
  | { kind: "none" }
  | { kind: "depth" }
  | { kind: "mono"; id: string; name: string }
  | { kind: "cli"; id: string };

function takeAsk(
  ask: Ask | undefined,
  roster: readonly MonoCandidate[],
  clis: readonly Presence[],
  lead: string | undefined,
  monoAllowed: boolean,
  policy: CrewPolicy | undefined,
): Taken {
  const monoId = cleanMonoId(ask?.monoId);
  if (monoId && !banned(policy, monoId)) {
    const mono = roster.find((row) => row.id === monoId && row.id !== lead && (row.depth ?? 0) < MAX_MONO_DEPTH);
    if (mono) {
      if (!monoAllowed) return { kind: "depth" };
      return { kind: "mono", id: mono.id, name: monoName(mono) };
    }
  }
  const cli = ask?.cli?.trim();
  if (cli && isCli(cli) && !banned(policy, cli) && clis.some((row) => row.cli === cli)) return { kind: "cli", id: cli };
  return { kind: "none" };
}

function finish(input: PickInput, picked: { kind: Kind; id: string; reason: string }, reason: string): MatePick {
  if (picked.kind === "mono") return monoResult(picked.id, reason);
  const fields = fieldsFor(input, picked.id);
  return cliResult(picked.id, fields.model, fields.effort, reason);
}

/** A role match says the role; the person's own default says so. */
function defaultOrRole(choice: Pick<Choice, "role" | "roleWord" | "name">): string {
  if (choice.role >= 2) return `${choice.roleWord} role prefers ${choice.name}.`;
  return `Your default is ${choice.name}.`;
}

/** The CLI a rule or the person's Mono, project or system default names, judged by the same resolver. */
function personSetCli(input: PickInput): string | undefined {
  const route = resolveRoute(
    { labels: [...(input.labels ?? [])], paths: [...(input.paths ?? [])] },
    input.rules ?? [],
    input.present ?? [],
    { defaults: input.defaults, catalog: input.catalog, policy: input.policy },
  );
  const set = route.cliFrom === "rule" || route.cliFrom === "mono" || route.cliFrom === "project" || route.cliFrom === "system";
  return set && route.cli ? route.cli : undefined;
}

function nothingReason(depth: number, hadMono: boolean): string {
  if (hadMono && depth >= MAX_MONO_DEPTH) return depthSentence(depth);
  return "Nothing available can take it.";
}

function choose(
  choices: readonly Choice[],
  roleCli: string | undefined,
  paused: ReadonlySet<string>,
): { kind: Kind; id: string; reason: string } | null {
  if (!choices.some((choice) => choice.available === 1)) return null;
  const pool = choices.filter((choice) => choice.available === 1);
  const ranked = [...pool].sort((a, b) => {
    if (b.role !== a.role) return b.role - a.role;
    if (a.fallbackRank !== b.fallbackRank) return a.fallbackRank - b.fallbackRank;
    if (b.defaultRank !== a.defaultRank) return b.defaultRank - a.defaultRank;
    return a.stable - b.stable;
  });
  const best = ranked[0];
  if (!best) return null;
  if (roleCli && paused.has(roleCli) && best.id !== roleCli) {
    return { kind: best.kind, id: best.id, reason: `${cliLabel(roleCli)} is at its quota, so this uses ${best.name}.` };
  }
  if (best.role > 0 && best.kind === "cli") {
    return { kind: "cli", id: best.id, reason: defaultOrRole(best) };
  }
  if (best.role > 0 && best.kind === "mono") {
    return { kind: "mono", id: best.id, reason: `${best.name} fits the ${best.roleWord} role.` };
  }
  if (best.fallbackRank < 1000) {
    return { kind: best.kind, id: best.id, reason: `Fallback order puts ${best.name} next.` };
  }
  return { kind: best.kind, id: best.id, reason: `Nothing else is set, so this uses ${best.name}.` };
}

/**
 * The pick's reason on a row, where the store keeps it: as `why` on the row's "recorded" line (delegations.rs).
 * The status notice is left alone. A secret is left for the row to drop.
 */
export function withPickReason<T extends CrewWorkerInput>(row: T, pick: Pick<MatePick, "reason">): T {
  const reason = pick.reason.replace(/\s+/g, " ").trim();
  if (!reason) return row;
  const log = [...(row.log ?? [])];
  const at = log.findIndex((entry) => entry?.event === "recorded");
  if (at >= 0) log[at] = { ...log[at], why: reason };
  else log.unshift({ event: "recorded", why: reason });
  return { ...row, log };
}

/** Shown crew rows for one project, so a test can read the reason the person sees. */
export function crewRowsWithReason(
  project: string,
  row: CrewWorkerInput,
  pick: Pick<MatePick, "reason">,
  now: number,
) {
  return crewRows({ project, rows: [withPickReason(row, pick)], now });
}

/** The parts of a crew route answer the reason reads. `ruleLabel` is the matched rule's first label. */
export type RouteReasonInput = {
  cli?: string | null;
  cliFrom?: string | null;
  ruleLabel?: string | null;
  skipped?: readonly { reason?: string | null }[] | null;
};

function plain(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function sourceSentence(input: RouteReasonInput): string {
  const cli = plain(input.cli);
  if (!cli) return "";
  const name = cliLabel(cli);
  switch (input.cliFrom) {
    case "override":
    case "brief":
      return `This task asks for ${name}.`;
    case "rule": {
      const label = norm(input.ruleLabel ?? "");
      if (isRoleSlot(label)) return `${roleSlotName(label)} role prefers ${name}.`;
      return label ? `A crew rule for ${label} picks ${name}.` : `A crew rule picks ${name}.`;
    }
    case "mono":
      return `This Mono's default is ${name}.`;
    case "project":
      return `This project's default is ${name}.`;
    case "system":
      return `Your default for every worker is ${name}.`;
    case "default":
      return `${name} is the first signed-in CLI.`;
    default:
      return "";
  }
}

/**
 * WP-141: why a delegated worker runs where it does, from the crew route that picked it. What was skipped
 * (Never use, the lock) comes first, each once, then where the CLI came from. Empty when the crew chose nothing.
 */
export function routeReason(input: RouteReasonInput | null | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const skip of input.skipped ?? []) {
    const reason = plain(skip?.reason);
    if (reason && !parts.includes(reason)) parts.push(reason);
  }
  const source = sourceSentence(input);
  if (source) parts.push(source);
  return parts.join(" ");
}
