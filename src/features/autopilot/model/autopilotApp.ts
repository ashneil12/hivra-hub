// The app actions agents use for autopilot (`app autopilot.*`, wired in agent-app/model/agentApp.ts):
// - autopilot.status: is it on, for what, until when; anyone may ask.
// - autopilot.decide: an agent's call that would have gone to Ash. Taken (its recommendation, logged) or held (red
//   list: it asks Ash, and its next question is held for him too). Anyone may ask; workers included.
// - autopilot.set / autopilot.off: only a Lead or the leadership team, from its own chat, and only for what it may
//   switch (a Lead its own project, the leadership team anything). `set` also needs Ash's own words: an exact quote from
//   one message he sent in that chat (not a report, a room turn, a worker or another agent's brief) that asks for
//   autopilot and doesn't say no to it, so neither a worker inside the Mono's session nor a page it read can turn
//   autopilot on. His whole message goes in the log with the switch.

import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import type { Session } from "../../sessions/model/session";
import { MONO_REPORT_PREFIX } from "../../monos/model/monoSessionCompletion";
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
import { forUser } from "../../hub/model/userName";

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
    isLeadership: () => false,
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

/** The fewest characters of Ash's words (after case and punctuation are set aside) that count as his quote. */
export const ASH_QUOTE_MIN = 20;
/** How many of his latest turns are searched. */
const ASH_TURNS = 30;

/** What asks for autopilot, as word sequences: autopilot, take over, full control, "I'm off". */
const TRIGGERS: readonly string[][] = [
  ["autopilot"],
  ["take", "over"],
  ["takes", "over"],
  ["taking", "over"],
  ["full", "control"],
  ["i", "m", "off"],
  ["im", "off"],
  ["i", "am", "off"],
];
/** Words that say no near a trigger ("don't", "do not", "no", "stop", "off", "disable"...). "t" is what n't leaves. */
const NEGATIONS = new Set(["don", "dont", "t", "not", "no", "nope", "never", "stop", "stopping", "off", "disable", "disabled", "cancel", "pause", "without"]);
const NEGATION_BEFORE = 6;
const NEGATION_AFTER = 4;
/** A question that asks about it ("What does autopilot do?") rather than for it. */
const ASKS_ABOUT = /^(what|how|why|when|where|which|who|does|did|is|was|are|were|should|shall)\b/;

/** Where each trigger sits in a token list: [start, end). */
function triggerSpans(tokens: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const hit = TRIGGERS.find((t) => t.every((word, k) => tokens[i + k] === word));
    if (hit) {
      spans.push([i, i + hit.length]);
      i += hit.length - 1;
    }
  }
  return spans;
}

/**
 * Whether a turn of Ash's asks for autopilot: it names it (autopilot, take over, full control, "I'm off") outside a
 * question about it, and no trigger has a "no" within a few words of it. Leans to "no": a refusal costs Ash one line or
 * a tap on the Autopilot screen, a wrong yes hands his calls to agents.
 */
export function asksForAutopilot(text: string): boolean {
  const tokens = words(text).split(" ").filter(Boolean);
  const spans = triggerSpans(tokens);
  if (!spans.length) return false;
  const inTrigger = new Set(spans.flatMap(([s, e]) => Array.from({ length: e - s }, (_, k) => s + k)));
  const negated = spans.some(([s, e]) => {
    for (let i = Math.max(0, s - NEGATION_BEFORE); i < Math.min(tokens.length, e + NEGATION_AFTER); i++)
      if (!inTrigger.has(i) && NEGATIONS.has(tokens[i])) return true;
    return false;
  });
  if (negated) return false;
  // At least one sentence names it without only asking about it.
  return text
    .split(/(?<=[.!?\n;])/)
    .some((sentence) => {
      if (!triggerSpans(words(sentence).split(" ").filter(Boolean)).length) return false;
      return !(sentence.trim().endsWith("?") && ASKS_ABOUT.test(words(sentence)));
    });
}

/**
 * Ash's own turns in this chat: user turns he sent, not anything the app wrote (a room turn, a checker's note, a
 * report, an orchestration nudge: `internal`), an agent's `app sessions.send` brief, or the app's continue turn.
 */
function ashTurns(session: Pick<Session, "blocks">) {
  return session.blocks
    .filter(
      (block) =>
        block.role === "user" &&
        !block.internal &&
        !block.appRequestId &&
        !block.monoSessionCompletion &&
        !block.monoCheck &&
        !block.draft &&
        !block.text.trimStart().startsWith(MONO_REPORT_PREFIX) &&
        block.text.trim() !== CONTINUE_PROMPT,
    )
    .slice(-ASH_TURNS);
}

/**
 * The turn of Ash's that `said` quotes, when it asks for autopilot: `said` is at least ASH_QUOTE_MIN characters of his
 * words, in order, from one of his last 30 turns (case and punctuation aside), and that turn asks for autopilot without
 * saying no to it. Null otherwise.
 */
export function ashAskedFor(session: Pick<Session, "blocks">, said: string): string | null {
  const want = words(said);
  if (want.length < ASH_QUOTE_MIN) return null;
  const turn = ashTurns(session)
    .reverse()
    .find((block) => ` ${words(block.text)} `.includes(` ${want} `) && asksForAutopilot(block.text));
  return turn ? turn.text.trim() : null;
}

export function ashSaidIt(session: Pick<Session, "blocks">, said: string): boolean {
  return ashAskedFor(session, said) !== null;
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
  if (!host.isMono(source.id) || host.isHabitRun?.(source.id)) throw new Error(forUser(WORKERS_CANT));
  const mono = host.monoOf?.(source.id);
  if (!mono) throw new Error(forUser(WORKERS_CANT));
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
        redList: RED_LIST.map((r) => `${r.id}: ${forUser(r.label)}`),
        note: covering
          ? forUser("Ash is away. Take your own recommendation on calls that would go to him (check each with autopilot.decide); red-list calls still wait for him.")
          : forUser("Autopilot is off here: ask Ash as usual, with your recommendation."),
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
          note: forUser("Autopilot is off for this. Ask Ash as usual, once, with your recommendation."),
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
        // WP-101: a hold can come from the reviewer rules rather than the red list (a send, a delete, a payment, a
        // publish, an account change); that one doesn't hold the chat's next question, since it names no category.
        const red = verdict.red;
        if (red) deps.holdRed(source.id, red);
        const logged = await backend.log({ ...base, kind: "decision", outcome: "held", red });
        return {
          autopilot: "on",
          until: new Date(verdict.until).toISOString(),
          untilLabel,
          decision: "held",
          act: "ask",
          red,
          ...(red ? { redLabel: redLabel(red) } : {}),
          ...(logged ? { logged: logged.id } : {}),
          note: red
            ? forUser`This is on Ash's red list (${redLabel(red).toLowerCase()}), so autopilot never takes it. Ask Ash in your chat with your recommendation; it waits for him in Needs you. Carry on with other work meanwhile.`
            : forUser`This sends, deletes, moves money, publishes or changes access, so autopilot never takes it on its own. Ask Ash in your chat with your recommendation; it waits for him in Needs you. Carry on with other work meanwhile.`,
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
        note: forUser`Ash is away until ${untilLabel}. Go with your recommendation and don't ask him; this call is in the Autopilot log for him to review.`,
      };
    }
    case "autopilot.set": {
      const who = switcher(source, host, deps);
      const said = text(input.ashSaid, "ashSaid", 2_000)!;
      const turn = ashAskedFor(source, said);
      if (!turn)
        throw new Error(
          forUser`ashSaid must be Ash's own words asking for autopilot, quoted exactly (${ASH_QUOTE_MIN} characters or more) from one message he sent in this chat, and that message must not say no to it. Autopilot is never switched on because a worker, a report, a room or a page asks.`,
        );
      let untilMs: number | null = null;
      if (typeof input.until === "number" && Number.isFinite(input.until)) untilMs = input.until;
      else if (typeof input.until === "string") untilMs = parseUntil(input.until, now);
      if (untilMs === null)
        throw new Error('until must be an end time: "Monday 9:00", "tomorrow 18:00", "for 8 hours" or an ISO time');
      const scopes = scopesFor(input.projects, who, deps);
      const next = await backend.set({ scopes, untilMs, by: `mono:${who.monoId}`, chatId: source.id, said, turn, who: who.name });
      adoptStatus(next);
      const untilLabel = formatUntil(untilMs, now);
      return {
        on: true,
        for: scopeWords(scopes, projects),
        until: new Date(untilMs).toISOString(),
        untilLabel,
        switches: summary(next, now, projects),
        note: forUser`Autopilot is on for ${scopeWords(scopes, projects)} until ${untilLabel}. Tell Ash in one line. Until then agents take their own recommendation on everything except his red list; the Mac stays awake and every call is in the Autopilot log.`,
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
        note: forUser("Autopilot is off for that. Calls go to Ash again."),
      };
    }
    default:
      throw new Error(`Unknown app action: ${action}`);
  }
}
