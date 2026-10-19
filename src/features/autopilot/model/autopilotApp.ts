// The app actions agents use for autopilot (`app autopilot.*`, wired in agent-app/model/agentApp.ts):
// - autopilot.status: is it on, for what, until when; anyone may ask.
// - autopilot.decide: an agent's call that would have gone to Ash. Taken (its recommendation, logged) or held (red
//   list: it asks Ash, and its next question is held for him too). Anyone may ask; workers included.
// - autopilot.set / autopilot.off: only a Lead or the leadership team, from its own chat, and only for what it may
//   switch (a Lead its own project, the leadership team anything). `set` also needs Ash's own words, and they must be
//   in that chat from Ash (not from a report, a worker or another agent's brief), so neither a worker inside the Mono's
//   session nor a page it read can turn autopilot on.

import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import type { Session } from "../../sessions/model/session";
import { MONO_REPORT_PREFIX } from "../../monos/model/monoSessionCompletion";
import { DEFAULT_TEAM_IDS } from "../../hub/model/builtInMonos";
import { leadFor } from "../../hub/model/hubLeads";
import { findMono, monoLook } from "../../monos/model/mono";
import { pathKey } from "../../../shared/lib/paths";
import {
  autopilotBackend,
  adoptStatus,
  coveringSwitch,
  activeSwitches,
  EVERYTHING,
  type AutopilotBackend,
  type AutopilotStatus,
} from "./autopilot";
import { chatProject, decideCall, type ProjectRef } from "./decide";
import { formatUntil, parseUntil } from "./endTime";
import { isRedCategory, RED_LIST, redLabel, type RedCategory } from "./redList";

export const AUTOPILOT_FIELDS: [string, readonly string[]][] = [
  ["autopilot.status", ["project"]],
  ["autopilot.decide", ["question", "recommendation", "why", "options", "red", "project"]],
  ["autopilot.set", ["until", "projects", "ashSaid"]],
  ["autopilot.off", ["projects", "ashSaid"]],
];

export type HubProjectRef = ProjectRef & { name: string };

/** What the handler needs from the app; the hook fills it, tests pass their own. */
export type AutopilotAppDeps = {
  backend: AutopilotBackend | null;
  projects(): readonly HubProjectRef[];
  now(): number;
  /** Hold this chat's next question for Ash (a red call it was told to ask him). */
  holdRed(sessionId: string, red: RedCategory): void;
  monoName(monoId: string): string;
  isLeadership(monoId: string): boolean;
  leadProject(monoId: string): string | undefined;
};

/** The minimum of agentApp's host this needs. */
export type AutopilotAppHost = {
  isMono(sessionId: string): boolean;
  isHabitRun?(sessionId: string): boolean;
  monoOf?(sessionId: string): { id: string; projects: readonly string[] } | undefined;
};

let projectsSource: () => readonly HubProjectRef[] = () => [];
const redHolds = new Map<string, { red: RedCategory; until: number }>();
export const RED_HOLD_MS = 30 * 60_000;

/** The app hook tells the handler where the hub's projects come from. */
export function setAutopilotProjects(source: () => readonly HubProjectRef[]): () => void {
  projectsSource = source;
  return () => {
    if (projectsSource === source) projectsSource = () => [];
  };
}

/** A chat told to ask Ash a red call: its next question within the window waits for him whatever its words. */
export function redHoldFor(sessionId: string, now = Date.now()): RedCategory | undefined {
  const hold = redHolds.get(sessionId);
  if (!hold) return undefined;
  if (hold.until <= now) {
    redHolds.delete(sessionId);
    return undefined;
  }
  return hold.red;
}

export function clearRedHold(sessionId: string): void {
  redHolds.delete(sessionId);
}

export function defaultAutopilotDeps(): AutopilotAppDeps {
  return {
    backend: autopilotBackend(),
    projects: () => projectsSource(),
    now: () => Date.now(),
    holdRed: (sessionId, red) => redHolds.set(sessionId, { red, until: Date.now() + RED_HOLD_MS }),
    monoName: (monoId) => {
      try {
        const mono = findMono(monoId);
        return mono ? monoLook(mono).name : (leadFor(monoId)?.name ?? monoId);
      } catch {
        return monoId;
      }
    },
    isLeadership: (monoId) => DEFAULT_TEAM_IDS.includes(monoId),
    leadProject: (monoId) => leadFor(monoId)?.projectId,
  };
}

function text(value: unknown, name: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must be a non-empty string under ${max} characters`);
  return value.trim();
}

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/auto[\s-]+pilot/g, "autopilot")
    .replace(/[^a-z0-9:]+/g, " ")
    .trim();
}

/**
 * Ash's words are in this chat, from him: a user turn he sent (directly or through a room), not an app report, an
 * agent's `app sessions.send` brief, or the app's own continue turn. The last 30 such turns are searched.
 */
export function ashSaidIt(session: Pick<Session, "blocks">, said: string): boolean {
  const want = words(said);
  if (want.length < 8 || !want.includes("autopilot")) return false;
  return session.blocks
    .filter(
      (block) =>
        block.role === "user" &&
        !block.appRequestId &&
        !block.monoSessionCompletion &&
        !block.draft &&
        !block.text.trimStart().startsWith(MONO_REPORT_PREFIX) &&
        block.text.trim() !== CONTINUE_PROMPT,
    )
    .slice(-30)
    .some((block) => words(block.text).includes(want));
}

function resolveProject(named: string, projects: readonly HubProjectRef[]): HubProjectRef | undefined {
  const key = named.trim().toLowerCase();
  return projects.find(
    (p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key || (!!p.folder && pathKey(p.folder) === pathKey(named)),
  );
}

function projectChoices(projects: readonly HubProjectRef[]): string {
  return projects.map((p) => `${p.id} (${p.name})`).join(", ") || "none listed";
}

/** The project a call is about: the one it names, else its chat's own. */
function callProject(source: Session, named: string | undefined, host: AutopilotAppHost, deps: AutopilotAppDeps): string | null {
  const projects = deps.projects();
  if (named) {
    const match = resolveProject(named, projects);
    if (!match) throw new Error(`Unknown project "${named}". Projects: ${projectChoices(projects)}`);
    return match.id;
  }
  const mono = host.monoOf?.(source.id);
  return chatProject(
    source,
    projects,
    mono && host.isMono(source.id) ? { projects: mono.projects, leadProjectId: deps.leadProject(mono.id) } : undefined,
  );
}

const WORKERS_CANT =
  "Only a Lead or the leadership team can switch autopilot, from their own chat, when Ash tells them to. Workers and habit runs can't.";

type Switcher = { monoId: string; name: string; allowed: "any" | string[] };

function switcher(source: Session, host: AutopilotAppHost, deps: AutopilotAppDeps): Switcher {
  if (!host.isMono(source.id) || host.isHabitRun?.(source.id)) throw new Error(WORKERS_CANT);
  const mono = host.monoOf?.(source.id);
  if (!mono) throw new Error(WORKERS_CANT);
  const name = deps.monoName(mono.id);
  if (deps.isLeadership(mono.id)) return { monoId: mono.id, name, allowed: "any" };
  const lead = deps.leadProject(mono.id);
  if (lead) return { monoId: mono.id, name, allowed: [lead] };
  const own = deps
    .projects()
    .filter((p) => p.folder && mono.projects.some((path) => pathKey(path) === pathKey(p.folder!)))
    .map((p) => p.id);
  if (!own.length) throw new Error("You have no hub project to switch autopilot for.");
  return { monoId: mono.id, name, allowed: own };
}

function scopesFor(input: unknown, who: Switcher, deps: AutopilotAppDeps): string[] {
  const projects = deps.projects();
  let named: string[];
  if (input === undefined) {
    return who.allowed === "any" ? [EVERYTHING] : who.allowed;
  } else if (typeof input === "string") {
    named = [input];
  } else if (Array.isArray(input) && input.length && input.length <= 20 && input.every((p) => typeof p === "string")) {
    named = input as string[];
  } else {
    throw new Error('projects must be "all" or a list of project ids');
  }
  const scopes = new Set<string>();
  for (const name of named) {
    if (["all", "everything", "*"].includes(name.trim().toLowerCase())) {
      if (who.allowed !== "any") throw new Error(`${who.name} can switch autopilot only for ${who.allowed.join(", ")}.`);
      scopes.add(EVERYTHING);
      continue;
    }
    const match = resolveProject(name, projects);
    if (!match) throw new Error(`Unknown project "${name}". Projects: ${projectChoices(projects)}`);
    if (who.allowed !== "any" && !who.allowed.includes(match.id))
      throw new Error(`${who.name} can switch autopilot only for ${who.allowed.join(", ")}.`);
    scopes.add(match.id);
  }
  return [...scopes];
}

function scopeWords(scopes: readonly string[], projects: readonly HubProjectRef[]): string {
  if (scopes.includes(EVERYTHING)) return "everything";
  return scopes.map((s) => projects.find((p) => p.id === s)?.name ?? s).join(", ");
}

function summary(status: AutopilotStatus | null, now: number, projects: readonly HubProjectRef[]) {
  const on = activeSwitches(status, now);
  return on.map((sw) => ({
    for: scopeWords([sw.scope], projects),
    scope: sw.scope,
    until: new Date(sw.untilMs).toISOString(),
    untilLabel: formatUntil(sw.untilMs, now),
  }));
}

const NEED_BACKEND = "Autopilot needs the desktop app.";

export async function handleAutopilotApp(
  source: Session,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  host: AutopilotAppHost,
  deps: AutopilotAppDeps = defaultAutopilotDeps(),
): Promise<unknown> {
  const backend = deps.backend;
  if (!backend) throw new Error(NEED_BACKEND);
  const now = deps.now();
  const projects = deps.projects();
  switch (action) {
    case "autopilot.status": {
      const status = await backend.status();
      const project = callProject(source, text(input.project, "project", 4096, false), host, deps);
      const covering = coveringSwitch(status, project, now);
      return {
        on: !!covering,
        ...(covering
          ? { until: new Date(covering.untilMs).toISOString(), untilLabel: formatUntil(covering.untilMs, now), for: scopeWords([covering.scope], projects) }
          : {}),
        switches: summary(status, now, projects),
        redList: RED_LIST.map((r) => `${r.id}: ${r.label}`),
        note: covering
          ? "Ash is away. Take your own recommendation on calls that would go to him (check each with autopilot.decide); red-list calls still wait for him."
          : "Autopilot is off here: ask Ash as usual, with your recommendation.",
      };
    }
    case "autopilot.decide": {
      const question = text(input.question, "question", 4_000)!;
      const recommendation = text(input.recommendation, "recommendation", 4_000)!;
      const why = text(input.why, "why", 4_000, false);
      if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 20 || input.options.some((o) => typeof o !== "string" || o.length > 1_000)))
        throw new Error("options must be a list of at most 20 short strings");
      if (input.red !== undefined && input.red !== "none" && !isRedCategory(input.red))
        throw new Error(`red must be one of: ${RED_LIST.map((r) => r.id).join(", ")}`);
      const project = callProject(source, text(input.project, "project", 4096, false), host, deps);
      const status = await backend.status();
      const covering = coveringSwitch(status, project, now);
      const verdict = decideCall({
        question,
        recommendation,
        why,
        options: input.options as string[] | undefined,
        declaredRed: input.red,
        until: covering?.untilMs,
      });
      if (verdict.outcome === "off")
        return {
          autopilot: "off",
          act: "ask",
          note: "Autopilot is off for this. Ask Ash as usual, once, with your recommendation.",
        };
      const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
      const untilLabel = formatUntil(verdict.until, now);
      const base = {
        project,
        chatId: source.id,
        monoId: mono?.id ?? null,
        who: mono ? deps.monoName(mono.id) : source.title || "Agent session",
        what: question,
        recommendation,
        detail: why ?? null,
        dedupe: `decide:${source.id}:${requestId}`,
      };
      if (verdict.outcome === "held") {
        deps.holdRed(source.id, verdict.red);
        const logged = await backend.log({ ...base, kind: "decision", outcome: "held", red: verdict.red });
        return {
          autopilot: "on",
          until: new Date(verdict.until).toISOString(),
          untilLabel,
          decision: "held",
          act: "ask",
          red: verdict.red,
          redLabel: redLabel(verdict.red),
          ...(logged ? { logged: logged.id } : {}),
          note: `This is on Ash's red list (${redLabel(verdict.red).toLowerCase()}), so autopilot never takes it. Ask Ash in your chat with your recommendation; it waits for him in Needs you. Carry on with other work meanwhile.`,
        };
      }
      const logged = await backend.log({ ...base, kind: "decision", outcome: "taken" });
      return {
        autopilot: "on",
        until: new Date(verdict.until).toISOString(),
        untilLabel,
        decision: "taken",
        act: "proceed",
        answer: verdict.answer,
        ...(logged ? { logged: logged.id } : {}),
        note: `Ash is away until ${untilLabel}. Go with your recommendation and don't ask him; this call is in the Autopilot log for him to review.`,
      };
    }
    case "autopilot.set": {
      const who = switcher(source, host, deps);
      const said = text(input.ashSaid, "ashSaid", 2_000)!;
      if (!ashSaidIt(source, said))
        throw new Error(
          "ashSaid must be Ash's own words asking for autopilot, as he sent them in this chat. Autopilot is never switched on because a worker, a report or a page asks.",
        );
      let untilMs: number | null = null;
      if (typeof input.until === "number" && Number.isFinite(input.until)) untilMs = input.until;
      else if (typeof input.until === "string") untilMs = parseUntil(input.until, now);
      if (untilMs === null)
        throw new Error('until must be an end time: "Monday 9:00", "tomorrow 18:00", "for 8 hours" or an ISO time');
      const scopes = scopesFor(input.projects, who, deps);
      const next = await backend.set({ scopes, untilMs, by: `mono:${who.monoId}`, chatId: source.id, said, who: who.name });
      adoptStatus(next);
      const untilLabel = formatUntil(untilMs, now);
      return {
        on: true,
        for: scopeWords(scopes, projects),
        until: new Date(untilMs).toISOString(),
        untilLabel,
        switches: summary(next, now, projects),
        note: `Autopilot is on for ${scopeWords(scopes, projects)} until ${untilLabel}. Tell Ash in one line. Until then agents take their own recommendation on everything except his red list; the Mac stays awake and every call is in the Autopilot log.`,
      };
    }
    case "autopilot.off": {
      const who = switcher(source, host, deps);
      const said = text(input.ashSaid, "ashSaid", 2_000, false);
      const status = await backend.status();
      const on = activeSwitches(status, now);
      const scopes = input.projects === undefined ? (who.allowed === "any" ? [] : who.allowed) : scopesFor(input.projects, who, deps);
      const ending = on.filter((sw) => (scopes.length ? scopes.includes(sw.scope) : true));
      if (!ending.length) return { on: on.length > 0, switches: summary(status, now, projects), note: "Nothing of yours was on." };
      const next = await backend.off({
        scopes: ending.map((sw) => sw.scope),
        by: `mono:${who.monoId}`,
        chatId: source.id,
        ...(said ? { said } : {}),
        who: who.name,
      });
      adoptStatus(next);
      return {
        on: activeSwitches(next, now).length > 0,
        ended: ending.map((sw) => scopeWords([sw.scope], projects)),
        switches: summary(next, now, projects),
        note: "Autopilot is off for that. Calls go to Ash again.",
      };
    }
    default:
      throw new Error(`Unknown app action: ${action}`);
  }
}
