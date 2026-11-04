// WP-20: every project with a code folder has one coding-team home chat, a first mate (WP-10).
// Crew rules stay empty, so WP-13's default CLI applies. Delivery is not stored: WP-12's default applies
// until someone saves a mode. The Lead's existing chat is that home; its blocks are not copied or replaced.
import { CLI_ORDER, isCli, type CliName } from "../../crew/model/clis";
import { defaultCli, type Presence } from "../../crew/model/resolve";
import { noteCodingTeamChat } from "./codingTeam";
import { isGlobalProject } from "./hubProjects";

const HOME_KEY = "monocode:coding-team-home";
const CLIS_KEY = "monocode:coding-team-clis";

export type DeliveryDefault = "local" | "checked-pr";

export type HomeSession = {
  id: string;
  cwd: string;
  blocks: unknown[];
  firstMate?: boolean;
  harness?: string;
  title?: string;
};

export type CodingTeamPlan = {
  homeId: string | null;
  patch?: { id: string; firstMate: true };
  create?: { id: string; cwd: string; blocks: unknown[]; harness: string; firstMate: true; title: string };
  /** Take the Lead's existing chat (or a chat already in the team) instead of making one. */
  migrated: boolean;
  created: boolean;
  /** The Lead's chat is known, or about to be made, and is not in the list yet. */
  waiting: boolean;
  /** Bind this home onto the Lead. Set only when the Lead has no chat of its own yet. */
  adoptLead?: boolean;
  cli: string | null;
  delivery: DeliveryDefault;
  /** Empty on purpose: WP-13's defaults apply when no rule is stored. */
  crewRules: [];
};

/** WP-12 `default_mode`: a checked pull request only when the project has a GitHub repo and gh is signed in. */
export function deliveryDefault(probe: { githubRepo?: string | null; ghSignedIn?: boolean }): DeliveryDefault {
  const repo = typeof probe.githubRepo === "string" ? probe.githubRepo.replace(/\r/g, "").trim() : "";
  return repo && probe.ghSignedIn === true ? "checked-pr" : "local";
}

let homes: Record<string, string> | undefined;
let clis: CliName[] | undefined;

function cleanToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r/g, "").trim();
  if (!text || text.length > 200 || text.includes("..") || /[\\/]/.test(text) || /[\u0000-\u001f]/.test(text)) return undefined;
  return text;
}

/** The stored map, read again each time. Two windows share localStorage, not this module's last copy. */
function readHomes(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_KEY) ?? "{}") as unknown;
    const next: Record<string, string> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const id = cleanToken(key);
        const sessionId = cleanToken(value);
        if (id && sessionId) next[id] = sessionId;
      }
    }
    homes = next;
    return next;
  } catch {
    return homes ?? {};
  }
}

function writeHomes(next: Record<string, string>): void {
  homes = next;
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(next));
  } catch {
    /* kept for this run */
  }
}

export function codingTeamHomeId(projectId: string): string | undefined {
  const id = cleanToken(projectId);
  return id ? readHomes()[id] : undefined;
}

/** Write the home id only when the stored value is still `expected` (`undefined` means none). */
export function compareAndSwapCodingTeamHome(projectId: string, expected: string | undefined, next: string): boolean {
  const id = cleanToken(projectId);
  const sessionId = cleanToken(next);
  if (!id || !sessionId) return false;
  const current = readHomes()[id];
  if (current === sessionId) return true;
  if (current !== expected) return false;
  const fresh = readHomes();
  if (fresh[id] === sessionId) return true;
  if (fresh[id] !== expected) return false;
  writeHomes({ ...fresh, [id]: sessionId });
  return true;
}

export function forgetCodingTeamHome(chatId: string): void {
  const id = cleanToken(chatId);
  if (!id) return;
  const map = readHomes();
  const projectId = Object.keys(map).find((key) => map[key] === id);
  if (!projectId) return;
  const fresh = readHomes();
  if (fresh[projectId] !== id) return;
  const next = { ...fresh };
  delete next[projectId];
  writeHomes(next);
}

export function resetCodingTeamHomes(): void {
  homes = undefined;
  clis = undefined;
}

export function sanitizeClis(raw: unknown): CliName[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CliName[] = [];
  for (const item of raw) {
    const text = cleanToken(item);
    if (!text || !isCli(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  out.sort((a, b) => CLI_ORDER.indexOf(a) - CLI_ORDER.indexOf(b));
  return out;
}

export function saveChosenClis(raw: unknown): CliName[] {
  clis = sanitizeClis(raw);
  try {
    localStorage.setItem(CLIS_KEY, JSON.stringify(clis));
  } catch {
    /* kept for this run */
  }
  return clis;
}

export function chosenClis(): CliName[] {
  if (clis) return clis;
  try {
    clis = sanitizeClis(JSON.parse(localStorage.getItem(CLIS_KEY) ?? "[]") as unknown);
  } catch {
    clis = [];
  }
  return clis;
}

/** The CLIs ticked at first launch, as WP-13 presence: installed and signed in. */
export function chosenPresence(): Presence[] {
  return chosenClis().map((cli) => ({ cli, installed: true, signedIn: true }));
}

export type PlanInput = {
  project: { id: string; name: string; shortName?: string; folder: string | null };
  sessions: readonly HomeSession[];
  lead?: { id: string; sessionId?: string };
  /** Last stored home. Omitted: read from this Mac. */
  homeId?: string;
  /** Chats already in this project's coding team, oldest first. Workers (`app-`) are skipped. */
  notedIds?: readonly string[];
  present: readonly Presence[];
  newId: string;
  /** Make the home chat when the project has none yet, including a Lead that has no chat. */
  allowCreate?: boolean;
  probe: { githubRepo?: string | null; ghSignedIn?: boolean };
};

function emptyPlan(present: readonly Presence[], probe: PlanInput["probe"]): CodingTeamPlan {
  return {
    homeId: null,
    migrated: false,
    created: false,
    waiting: false,
    cli: defaultCli(present),
    delivery: deliveryDefault(probe),
    crewRules: [],
  };
}

function folderOf(folder: string | null): string {
  return typeof folder === "string" ? folder.replace(/\r/g, "").trim() : "";
}

/** What the one home chat should be. Does not write. */
export function planCodingTeam(input: PlanInput): CodingTeamPlan {
  const plan = emptyPlan(input.present, input.probe);
  const projectId = cleanToken(input.project.id);
  const folder = folderOf(input.project.folder);
  if (!projectId || isGlobalProject(projectId) || !folder) return plan;

  const byId = new Map<string, HomeSession>();
  for (const row of input.sessions) {
    if (row && typeof row.id === "string" && !byId.has(row.id)) byId.set(row.id, row);
  }
  const stored = input.homeId !== undefined ? cleanToken(input.homeId) : codingTeamHomeId(projectId);
  if (stored && byId.has(stored)) return { ...plan, homeId: stored, patch: { id: stored, firstMate: true } };

  const leadSession = cleanToken(input.lead?.sessionId);
  if (leadSession && byId.has(leadSession)) {
    return { ...plan, homeId: leadSession, migrated: true, patch: { id: leadSession, firstMate: true } };
  }
  if (leadSession) return { ...plan, homeId: leadSession, waiting: true };

  for (const noted of input.notedIds ?? []) {
    const id = cleanToken(noted);
    if (id && !id.startsWith("app-") && byId.has(id)) {
      return { ...plan, homeId: id, migrated: true, adoptLead: !!input.lead && !input.lead.sessionId, patch: { id, firstMate: true } };
    }
  }

  const newId = cleanToken(input.newId);
  if (input.allowCreate && newId) {
    const cli = plan.cli && isCli(plan.cli) ? plan.cli : "claude";
    return {
      ...plan,
      homeId: newId,
      created: true,
      adoptLead: !!input.lead && !input.lead.sessionId,
      create: { id: newId, cwd: folder, blocks: [], harness: cli, firstMate: true, title: "Coding team" },
    };
  }
  return { ...plan, waiting: true };
}

export type SettleInput<S extends HomeSession> = PlanInput & {
  sessions: readonly S[];
  /** Called when the home is a chat the Lead did not already point at. */
  bindLead?: (leadId: string, sessionId: string) => void;
  /** The Lead's CLI, set only when this call creates the home. An existing chat is left as it is. */
  setLeadCli?: (leadId: string, cli: string) => void;
  /** Turn the planned chat into the app's session. Tests use the plan's own object. */
  inflate?: (draft: NonNullable<CodingTeamPlan["create"]>) => S;
};

/**
 * Remember the home and mark that one chat as a first mate. The sessions array is the same reference when nothing
 * changed. A home another window stored first wins.
 */
export function settleCodingTeam<S extends HomeSession>(input: SettleInput<S>): { sessions: S[]; changed: boolean; plan: CodingTeamPlan } {
  const projectId = cleanToken(input.project.id);
  let plan = planCodingTeam(input);
  if (!projectId || !plan.homeId) return { sessions: input.sessions as S[], changed: false, plan };

  const byId = new Map(input.sessions.map((row) => [row.id, row]));
  const current = codingTeamHomeId(projectId);
  if (current && current !== plan.homeId && byId.has(current)) {
    plan = { ...plan, homeId: current, migrated: false, created: false, waiting: false, adoptLead: false, create: undefined, patch: { id: current, firstMate: true } };
  }
  const nextHome = plan.homeId;
  if (!nextHome) return { sessions: input.sessions as S[], changed: false, plan };
  if (!compareAndSwapCodingTeamHome(projectId, current, nextHome)) {
    const winner = codingTeamHomeId(projectId);
    if (winner && winner !== plan.homeId && byId.has(winner)) {
      plan = { ...plan, homeId: winner, migrated: false, created: false, waiting: false, adoptLead: false, create: undefined, patch: { id: winner, firstMate: true } };
    } else if (winner !== plan.homeId) {
      return { sessions: input.sessions as S[], changed: false, plan: { ...plan, waiting: true, create: undefined, patch: undefined } };
    }
  }

  let sessions = input.sessions as S[];
  let changed = false;
  if (plan.create && !byId.has(plan.create.id)) {
    sessions = [...sessions, input.inflate ? input.inflate(plan.create) : (plan.create as S)];
    changed = true;
  }
  const patchId = plan.patch?.id ?? plan.create?.id;
  if (patchId) {
    const row = sessions.find((item) => item.id === patchId);
    if (row && row.firstMate !== true) {
      sessions = sessions.map((item) => (item.id === patchId ? { ...item, firstMate: true as const } : item));
      changed = true;
    }
  }
  if (!plan.waiting && plan.homeId) noteCodingTeamChat(plan.homeId, projectId);
  if (plan.adoptLead && input.lead && !input.lead.sessionId && plan.homeId) input.bindLead?.(input.lead.id, plan.homeId);
  if (plan.created && plan.adoptLead && input.lead && plan.cli) input.setLeadCli?.(input.lead.id, plan.cli);
  return { sessions: changed ? sessions : (input.sessions as S[]), changed, plan };
}

/** First launch: a project name, the CLIs ticked, and a group only when both were chosen. */
export function firstLaunchChoice(input: { projectName: unknown; group: unknown; clis: unknown }): {
  projectName: string | null;
  group: boolean;
  clis: CliName[];
} {
  const name = typeof input.projectName === "string" ? input.projectName.replace(/\r/g, "").trim().slice(0, 80) : "";
  return {
    projectName: name || null,
    group: !!name && input.group === true,
    clis: sanitizeClis(input.clis),
  };
}

const starting = new Map<string, Promise<"opened" | "unavailable">>();

/**
 * Make the first project and open its coding team. A second call for the same name shares the first. A failed create,
 * or the project going away while that runs, does not open anything.
 */
export async function beginFirstProject(
  choice: { projectName: string; group: boolean },
  deps: {
    create: (name: string) => Promise<{ id: string; folder: string | null }>;
    addGroup: (projectId: string) => void;
    open: (projectId: string) => void;
    stillThere?: () => boolean;
  },
): Promise<"opened" | "unavailable"> {
  const name = choice.projectName.replace(/\r/g, "").trim();
  if (!name) return "unavailable";
  const pending = starting.get(name);
  if (pending) return pending;
  const run = (async () => {
    let made: { id: string; folder: string | null };
    try {
      made = await deps.create(name);
    } catch {
      return "unavailable" as const;
    }
    if (deps.stillThere && !deps.stillThere()) return "unavailable" as const;
    if (!made?.id) return "unavailable" as const;
    if (choice.group) deps.addGroup(made.id);
    deps.open(made.id);
    return "opened" as const;
  })().finally(() => {
    if (starting.get(name) === run) starting.delete(name);
  });
  starting.set(name, run);
  return run;
}
