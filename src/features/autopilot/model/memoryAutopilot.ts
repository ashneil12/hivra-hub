// An in-memory autopilot backend with the Rust store's rules (src-tauri/src/autopilot.rs): for tests, and for the
// browser preview behind the examples flag (hub-dev.html), where there is no Rust side.

import type {
  ArmInput,
  ArmResult,
  AutopilotBackend,
  AutopilotStatus,
  AutoResumeSettings,
  LogEntry,
  LogInput,
  Resume,
  Switch,
} from "./autopilot";

const MAX_SPAN = 14 * 86_400_000;
const MAX_AUTO_RESUMES = 3;

export type MemoryAutopilot = AutopilotBackend & {
  switches: Map<string, Switch>;
  entries: LogEntry[];
  resumesById: Map<string, Resume>;
};

export function memoryAutopilot(clock: () => number = Date.now, seed: LogEntry[] = []): MemoryAutopilot {
  const switches = new Map<string, Switch>();
  const entries: LogEntry[] = [...seed];
  const dedupes = new Set<string>();
  const resumesById = new Map<string, Resume>();
  let autoResume: AutoResumeSettings = { default: true, projects: {} };
  let seenAt = 0;
  let id = 0;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());

  const add = (input: LogInput, at = clock()): LogEntry | null => {
    if (input.dedupe) {
      if (dedupes.has(input.dedupe)) return null;
      dedupes.add(input.dedupe);
    }
    const entry: LogEntry = {
      id: `ap-mem-${++id}`,
      at,
      kind: input.kind,
      outcome: input.outcome,
      project: input.project ?? null,
      chatId: input.chatId ?? null,
      monoId: input.monoId ?? null,
      who: input.who ?? null,
      what: input.what,
      recommendation: input.recommendation ?? null,
      red: input.red ?? null,
      detail: input.detail ?? null,
    };
    entries.push(entry);
    return entry;
  };

  const expire = () => {
    const now = clock();
    for (const [scope, sw] of switches) {
      if (sw.untilMs <= now) {
        switches.delete(scope);
        add({ kind: "switch", outcome: "ended", what: `Autopilot ended for ${scope === "*" ? "everything" : scope} at its end time`, who: "Autopilot" });
      }
    }
  };

  const status = (): AutopilotStatus => {
    expire();
    const on = [...switches.values()];
    return {
      switches: on,
      awake: { supported: true, held: on.length > 0, error: null },
      relaunch: { supported: false, installed: false, reason: "Dev copies don't relaunch themselves." },
      autoResume,
      logSeenAt: seenAt,
      unseen: entries.filter((e) => ["decision", "question", "approval"].includes(e.kind) && e.at > seenAt).length,
      relaunchedAfterCrash: false,
      now: clock(),
    };
  };

  return {
    switches,
    entries,
    resumesById,
    status: async () => status(),
    set: async (input) => {
      const now = clock();
      if (input.untilMs - now < 60_000) throw new Error("The end time has to be at least a minute from now");
      if (input.untilMs - now > MAX_SPAN) throw new Error("Autopilot runs for at most 14 days at a time");
      if (!input.scopes.length) throw new Error("Say what autopilot is for: everything or a project");
      for (const scope of input.scopes)
        switches.set(scope, { scope, untilMs: input.untilMs, setBy: input.by, setAt: now, chatId: input.chatId ?? null, said: input.said ?? null });
      add({ kind: "switch", outcome: "on", what: `Autopilot on for ${input.scopes.includes("*") ? "everything" : input.scopes.join(", ")}`, who: input.who ?? input.by, chatId: input.chatId ?? null, detail: input.turn ?? input.said ?? null });
      changed();
      return status();
    },
    off: async (input) => {
      const scopes = input.scopes?.length ? input.scopes : [...switches.keys()];
      const ended = scopes.filter((s) => switches.delete(s));
      if (ended.length) add({ kind: "switch", outcome: "off", what: `Autopilot off for ${ended.includes("*") ? "everything" : ended.join(", ")}`, who: input.who ?? input.by });
      changed();
      return status();
    },
    log: async (input) => {
      const entry = add(input);
      if (entry) changed();
      return entry;
    },
    listLog: async (limit = 200, before) =>
      [...entries]
        .filter((e) => before === undefined || e.at < before)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit),
    seen: async (at) => {
      seenAt = Math.max(seenAt, at);
      changed();
    },
    setAutoResume: async (input) => {
      const projects = { ...autoResume.projects };
      if (input.project) {
        if (typeof input.value === "boolean") projects[input.project] = input.value;
        else delete projects[input.project];
      }
      autoResume = { default: input.default ?? autoResume.default, projects };
      changed();
      return autoResume;
    },
    arm: async (input: ArmInput): Promise<ArmResult> => {
      const now = clock();
      if (input.resetsAt <= now) return { armed: false, resume: null, reason: "The reset time has already passed" };
      const existing = resumesById.get(input.sessionId);
      if (existing?.state === "armed" && existing.resetsAt === input.resetsAt) return { armed: true, resume: existing, reason: null };
      if (existing?.state === "gave_up") return { armed: false, resume: existing, reason: "It stopped at a usage limit 3 times in a row; it waits for you now" };
      const attempts = !existing || existing.state === "cancelled" ? 1 : existing.attempts + 1;
      const row: Resume = {
        sessionId: input.sessionId,
        resetsAt: input.resetsAt,
        resumeAt: Math.max(input.resumeAt, input.resetsAt),
        attempts: Math.min(attempts, MAX_AUTO_RESUMES + 1),
        state: attempts > MAX_AUTO_RESUMES ? "gave_up" : "armed",
        title: input.title ?? existing?.title ?? null,
        armedAt: now,
        updatedAt: now,
      };
      resumesById.set(input.sessionId, row);
      return row.state === "armed"
        ? { armed: true, resume: row, reason: null }
        : { armed: false, resume: row, reason: "It stopped at a usage limit 3 times in a row; it waits for you now" };
    },
    settle: async (sessionId, outcome) => {
      if (outcome === "finished") {
        resumesById.delete(sessionId);
        return null;
      }
      const row = resumesById.get(sessionId);
      if (!row) return null;
      const next = { ...row, state: outcome, updatedAt: clock() } as Resume;
      resumesById.set(sessionId, next);
      return next;
    },
    resumes: async () => [...resumesById.values()].filter((r) => r.state !== "cancelled"),
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

/** What the browser preview shows: a weekend's worth of calls (examples flag only; labelled "Example:"). */
export function exampleAutopilot(now = Date.now()): MemoryAutopilot {
  const h = 3_600_000;
  const seed: LogEntry[] = [
    { id: "ex-1", at: now - 30 * h, kind: "switch", outcome: "on", project: null, chatId: "ex-cos", monoId: "ada", who: "Chief of Staff", what: "Example: Autopilot on for everything", recommendation: null, red: null, detail: "go autopilot until monday 9" },
    { id: "ex-2", at: now - 26 * h, kind: "decision", outcome: "taken", project: "hivra", chatId: "ex-hivra", monoId: "hivra-lead", who: "Hivra lead", what: "Example: Split the canary fix into two PRs?", recommendation: "Yes: the migration first, the UI second", red: null, detail: null },
    { id: "ex-3", at: now - 20 * h, kind: "question", outcome: "taken", project: "vg-game", chatId: "ex-exo", monoId: "vg-game-lead", who: "EXO lead", what: "Example: Which lighting pass first, Dusk or Night?", recommendation: "Dusk", red: null, detail: null },
    { id: "ex-4", at: now - 9 * h, kind: "decision", outcome: "held", project: "hivra", chatId: "ex-hivra", monoId: "hivra-lead", who: "Hivra lead", what: "Example: Refund the customer who was double charged?", recommendation: "Refund the second charge", red: "money", detail: null },
    { id: "ex-5", at: now - 2 * h, kind: "approval", outcome: "taken", project: "hub", chatId: "ex-hub", monoId: "hub-lead", who: "MonoCode Hub lead", what: "Example: npm run check", recommendation: "Allowed", red: null, detail: null },
  ];
  const backend = memoryAutopilot(() => Date.now(), seed);
  backend.switches.set("*", { scope: "*", untilMs: now + 40 * h, setBy: "mono:ada", setAt: now - 30 * h, chatId: "ex-cos", said: "go autopilot until monday 9" });
  return backend;
}
