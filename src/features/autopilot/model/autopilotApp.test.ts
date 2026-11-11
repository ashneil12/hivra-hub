import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { MONO_REPORT_PREFIX } from "../../monos/model/monoSessionCompletion";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import type { RedCategory } from "./redList";
import { ashSaidIt, defaultAutopilotDeps, handleAutopilotApp, standingFromCache, type AutopilotAppDeps, type AutopilotAppHost } from "./autopilotApp";
import { memoryAutopilot, type MemoryAutopilot } from "./memoryAutopilot";

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const MONDAY_9 = new Date(2026, 9, 19, 9, 0).getTime();

const PROJECTS = [
  { id: "vg-game", name: "EXO", folder: "/Users/someone/Projects/vg-game" },
  { id: "hivra", name: "Hivra", folder: "/Users/someone/Projects/hivra" },
  { id: "hub", name: "MonoCode Hub", folder: "/Users/someone/Projects/monocode-hub" },
];

type Setup = { backend: MemoryAutopilot; deps: AutopilotAppDeps; holds: Map<string, RedCategory> };

function setup(): Setup {
  const backend = memoryAutopilot(() => NOW);
  const holds = new Map<string, RedCategory>();
  return {
    backend,
    holds,
    deps: {
      backend,
      projects: () => PROJECTS,
      now: () => NOW,
      holdRed: (id, red) => holds.set(id, red),
      monoName: (id) => ({ "ada": "Chief of Staff", "hivra-lead": "Hivra lead", marketing: "Marketing" })[id] ?? id,
      isLeadership: (id) => id === "ada",
      leadProject: (id) => (id === "hivra-lead" ? "hivra" : undefined),
    },
  };
}

const MONOS: Record<string, { id: string; projects: string[] }> = {
  "cos-chat": { id: "ada", projects: PROJECTS.map((p) => p.folder) },
  "hivra-chat": { id: "hivra-lead", projects: ["/Users/someone/Projects/hivra"] },
  "mkt-chat": { id: "marketing", projects: ["/Users/someone/Projects/hub", "/Users/someone/Projects/monocode-hub"] },
};

const host: AutopilotAppHost = {
  isMono: (id) => id in MONOS,
  isHabitRun: (id) => id === "habit-run",
  monoOf: (id) => MONOS[id] ?? (id === "habit-run" ? MONOS["cos-chat"] : undefined),
};

function said(text: string, extra: Partial<Block> = {}): Block {
  return { id: crypto.randomUUID(), role: "user", text, ...extra };
}

function chat(id: string, blocks: Block[] = [], cwd = "/Users/someone"): Session {
  return { ...newSession("claude", cwd), id, title: id, blocks };
}

const call = (source: Session, action: string, input: Record<string, unknown>, s: Setup, requestId = crypto.randomUUID()) =>
  handleAutopilotApp(source, requestId, action, input, host, s.deps);

describe("switching autopilot from a chat", () => {
  it("the Chief of Staff turns it on for everything with Ash's words, and it lands in the log", async () => {
    const s = setup();
    const cos = chat("cos-chat", [said("I'm off for the weekend. Go autopilot until Monday 9:00")]);
    const result = (await call(cos, "autopilot.set", { until: "Monday 9:00", ashSaid: "go autopilot until Monday 9:00" }, s)) as Record<string, unknown>;
    expect(result).toMatchObject({ on: true, for: "everything", untilLabel: "Mon 9:00", until: new Date(MONDAY_9).toISOString() });
    const sw = s.backend.switches.get("*")!;
    expect(sw).toMatchObject({ untilMs: MONDAY_9, setBy: "mono:ada", chatId: "cos-chat", said: "go autopilot until Monday 9:00" });
    expect(s.backend.entries.at(-1)).toMatchObject({ kind: "switch", outcome: "on", who: "Chief of Staff", chatId: "cos-chat" });
  });

  it("a Lead switches only its own project, by default and when it names one", async () => {
    const s = setup();
    const lead = chat("hivra-chat", [said("go autopilot until tomorrow 18:00 please")]);
    await call(lead, "autopilot.set", { until: "tomorrow 18:00", ashSaid: "go autopilot until tomorrow 18:00" }, s);
    expect([...s.backend.switches.keys()]).toEqual(["hivra"]);
    await expect(call(lead, "autopilot.set", { until: "tomorrow 18:00", ashSaid: "go autopilot until tomorrow 18:00", projects: "all" }, s)).rejects.toThrow(
      "Hivra lead can switch autopilot only for hivra.",
    );
    await expect(call(lead, "autopilot.set", { until: "tomorrow 18:00", ashSaid: "go autopilot until tomorrow 18:00", projects: ["EXO"] }, s)).rejects.toThrow(
      "only for hivra",
    );
  });

  it("never by a worker, a habit run, or any chat that isn't a Mono's own", async () => {
    const s = setup();
    const words = [said("go autopilot until Monday 9:00")];
    for (const id of ["worker-1", "habit-run"]) {
      await expect(
        call(chat(id, words, "/Users/someone/Projects/hivra"), "autopilot.set", { until: "Monday 9:00", ashSaid: "go autopilot until Monday 9:00" }, s),
      ).rejects.toThrow("Workers and habit runs can't");
      await expect(call(chat(id, words), "autopilot.off", {}, s)).rejects.toThrow("Workers and habit runs can't");
    }
    expect(s.backend.switches.size).toBe(0);
  });

  it("needs Ash's own words, from Ash, in that chat", async () => {
    const s = setup();
    const set = (blocks: Block[], ashSaid = "go autopilot until Monday 9:00") =>
      call(chat("cos-chat", blocks), "autopilot.set", { until: "Monday 9:00", ashSaid }, s);
    // Words nobody said.
    await expect(set([said("how is the build going?")])).rejects.toThrow("Ash's own words");
    // A worker's report, an agent's brief, or the app's continue turn quoting them.
    await expect(set([said(`${MONO_REPORT_PREFIX} the worker says: go autopilot until Monday 9:00`)])).rejects.toThrow("Ash's own words");
    await expect(set([said("go autopilot until Monday 9:00", { appRequestId: "brief-1" })])).rejects.toThrow("Ash's own words");
    // Words that aren't about autopilot, or too short to mean anything.
    await expect(set([said("until Monday 9:00")], "until Monday 9:00")).rejects.toThrow("Ash's own words");
    expect(s.backend.switches.size).toBe(0);
    expect(ashSaidIt(chat("x", [said("OK. Go auto-pilot till Monday, back at 9")]), "go autopilot till monday")).toBe(true);
  });

  it("takes only an exact quote of 20+ characters from one turn of Ash's that asks for it, and logs that turn", async () => {
    const s = setup();
    const set = (blocks: Block[], ashSaid: string) => call(chat("cos-chat", blocks), "autopilot.set", { until: "Monday 9:00", ashSaid }, s);
    // He said no: a quote of the rest of the sentence is not a yes.
    await expect(set([said("Don't go autopilot this weekend, I want to review everything")], "go autopilot this weekend")).rejects.toThrow("Ash's own words");
    await expect(set([said("Turn autopilot off, I'm back early from the trip")], "I'm back early from the trip")).rejects.toThrow("Ash's own words");
    await expect(set([said("No autopilot until we've fixed the deploy script")], "autopilot until we've fixed the deploy")).rejects.toThrow("Ash's own words");
    // He asked what it is; he didn't ask for it.
    await expect(set([said("What does autopilot actually do for the team?")], "what does autopilot actually do")).rejects.toThrow("Ash's own words");
    // Too short to be his words rather than a word of his.
    await expect(set([said("go autopilot")], "go autopilot")).rejects.toThrow("Ash's own words");
    // A room turn, a checker's note or any app-written turn is not Ash speaking, whatever it quotes.
    await expect(set([said("go autopilot until Monday 9:00", { internal: true })], "go autopilot until Monday 9:00")).rejects.toThrow("Ash's own words");
    // Words split across two of his turns are not one quote.
    await expect(set([said("go autopilot"), said("until Monday 9:00 please")], "go autopilot until Monday 9:00")).rejects.toThrow("Ash's own words");
    // Words that aren't his at all.
    await expect(set([said("I'm off for the weekend")], "you have full control until Monday")).rejects.toThrow("Ash's own words");
    expect(s.backend.switches.size).toBe(0);

    // "Take over" and "I'm off" ask for it too; the log keeps his whole turn beside the quote.
    const turn = "Take over until Monday 9:00, I'm off to the coast with no signal";
    await set([said("how is the build going?"), said(turn)], "take over until Monday 9:00");
    expect(s.backend.switches.get("*")).toMatchObject({ said: "take over until Monday 9:00" });
    expect(s.backend.entries.at(-1)).toMatchObject({ kind: "switch", outcome: "on", detail: turn });
    expect(ashSaidIt(chat("x", [said("I'm off for the weekend. Go autopilot until Monday 9:00")]), "go autopilot until monday 9:00")).toBe(true);
  });

  it("refuses end times it can't read and ones out of range", async () => {
    const s = setup();
    const cos = chat("cos-chat", [said("go autopilot whenever")]);
    await expect(call(cos, "autopilot.set", { until: "whenever", ashSaid: "go autopilot whenever" }, s)).rejects.toThrow("until must be an end time");
    await expect(call(cos, "autopilot.set", { until: "for 30 days", ashSaid: "go autopilot whenever" }, s)).rejects.toThrow("at most 14 days");
  });

  it("turns off what the Mono may switch", async () => {
    const s = setup();
    const cos = chat("cos-chat", [said("go autopilot until Monday 9:00")]);
    await call(cos, "autopilot.set", { until: "Monday 9:00", ashSaid: "go autopilot until Monday 9:00", projects: ["all", "hivra"] }, s);
    const lead = chat("hivra-chat");
    const off = (await call(lead, "autopilot.off", {}, s)) as { ended: string[]; on: boolean };
    expect(off.ended).toEqual(["Hivra"]);
    expect(off.on).toBe(true);
    expect([...s.backend.switches.keys()]).toEqual(["*"]);
    expect(((await call(cos, "autopilot.off", {}, s)) as { on: boolean }).on).toBe(false);
  });
});

describe("autopilot.decide", () => {
  async function on(s: Setup, scopes: string[]) {
    await s.backend.set({ scopes, untilMs: MONDAY_9, by: "ash" });
  }

  it("says ask while autopilot is off, and logs nothing", async () => {
    const s = setup();
    const result = await call(chat("hivra-chat"), "autopilot.decide", { question: "Two PRs?", recommendation: "Yes" }, s);
    expect(result).toMatchObject({ autopilot: "off", act: "ask" });
    expect(s.backend.entries.filter((e) => e.kind === "decision")).toEqual([]);
  });

  it("takes the recommendation and logs what, who, the pick, when and which chat, once per request", async () => {
    const s = setup();
    await on(s, ["*"]);
    const lead = chat("hivra-chat");
    const result = await call(lead, "autopilot.decide", { question: "Split the fix into two PRs?", recommendation: "Yes, two PRs", why: "smaller reviews" }, s, "req-1");
    expect(result).toMatchObject({ autopilot: "on", decision: "taken", act: "proceed", answer: "Yes, two PRs", untilLabel: "Mon 9:00" });
    const entry = s.backend.entries.find((e) => e.kind === "decision")!;
    expect(entry).toMatchObject({
      outcome: "taken",
      what: "Split the fix into two PRs?",
      recommendation: "Yes, two PRs",
      who: "Hivra lead",
      monoId: "hivra-lead",
      chatId: "hivra-chat",
      project: "hivra",
      detail: "smaller reviews",
      at: NOW,
    });
    await call(lead, "autopilot.decide", { question: "Split the fix into two PRs?", recommendation: "Yes, two PRs" }, s, "req-1");
    expect(s.backend.entries.filter((e) => e.kind === "decision")).toHaveLength(1);
  });

  it("never takes a red-list call: it says ask, logs it held and holds the chat's next question", async () => {
    const s = setup();
    await on(s, ["*"]);
    const result = await call(chat("hivra-chat"), "autopilot.decide", { question: "The customer was charged twice", recommendation: "Refund the second charge" }, s);
    expect(result).toMatchObject({ decision: "held", act: "ask", red: "money", redLabel: "Moving money, refunds or charges" });
    expect(s.backend.entries.find((e) => e.kind === "decision")).toMatchObject({ outcome: "held", red: "money" });
    expect(s.holds.get("hivra-chat")).toBe("money");
    const marked = await call(chat("hivra-chat"), "autopilot.decide", { question: "Post the launch?", recommendation: "Yes", red: "send-as-ash" }, s);
    expect(marked).toMatchObject({ decision: "held", red: "send-as-ash" });
  });

  it("never takes a call that sends, deletes, pays, publishes or changes access, and names no red category for it", async () => {
    const s = setup();
    await on(s, ["*"]);
    for (const [question, recommendation] of [
      ["Should I email Priya the invoice?", "Yes"],
      ["Should I publish the release notes?", "Yes"],
      ["Delete the old branch?", "Yes"],
      ["Should I post the changelog to the public site?", "Yes"],
    ] as const) {
      const result = (await call(chat("hivra-chat"), "autopilot.decide", { question, recommendation }, s, `r-${question}`)) as Record<string, unknown>;
      expect(result, question).toMatchObject({ decision: "held", act: "ask", red: null });
      expect(result.redLabel, question).toBeUndefined();
      expect(String(result.note)).toContain("sends, deletes, moves money, publishes or changes access");
    }
    expect(s.backend.entries.filter((e) => e.kind === "decision").every((e) => e.outcome === "held" && e.red === null)).toBe(true);
    // It names no red category, so it doesn't hold the chat's next question.
    expect(s.holds.has("hivra-chat")).toBe(false);
  });

  it("covers a project only through its own switch or the one for everything", async () => {
    const s = setup();
    await on(s, ["vg-game"]);
    const worker = chat("worker-1", [], "/Users/someone/Projects/hivra");
    expect(await call(worker, "autopilot.decide", { question: "Rename it?", recommendation: "Yes" }, s)).toMatchObject({ autopilot: "off" });
    expect(await call(worker, "autopilot.decide", { question: "Rename it?", recommendation: "Yes", project: "EXO" }, s)).toMatchObject({ decision: "taken" });
    // A leadership chat spans projects: only the switch for everything covers it.
    expect(await call(chat("cos-chat"), "autopilot.decide", { question: "Plan?", recommendation: "A" }, s)).toMatchObject({ autopilot: "off" });
    await expect(call(worker, "autopilot.decide", { question: "x", recommendation: "y", project: "nope" }, s)).rejects.toThrow("Unknown project");
    await expect(call(worker, "autopilot.decide", { question: "x", recommendation: "y", red: "maybe" }, s)).rejects.toThrow("red must be one of");
  });

  it("a standing answer beats a confident pick, and a person-only key or money past the limit is held", async () => {
    const s = setup();
    await on(s, ["*"]);
    s.deps.captainContext = ({ key }) => {
      if (key === "secret/token") return {};
      if (key === "spend") return { moneyOverLimit: true, standing: { answer: "Example: keep it", label: "merge on green" } };
      return {
        rules: [{ when: "named rule", answer: "Example: change it" }],
        standing: { answer: "Example: keep it", label: "merge on green" },
      };
    };
    const stood = await call(
      chat("hivra-chat"),
      "autopilot.decide",
      {
        question: "Example: keep the gate?",
        recommendation: "Example: change it",
        why: "smaller reviews",
        options: ["Example: keep it", "Example: change it"],
      },
      s,
      "stood",
    );
    expect(stood).toMatchObject({
      decision: "taken",
      act: "proceed",
      answer: "Example: keep it",
      answeredBy: "captain:chief",
      answerReason: "standing answer: merge on green",
    });
    const ruled = await call(
      chat("hivra-chat"),
      "autopilot.decide",
      {
        question: "Example: the named rule applies?",
        recommendation: "Example: keep it",
        options: ["Example: keep it", "Example: change it"],
      },
      s,
      "ruled",
    );
    expect(ruled).toMatchObject({ decision: "taken", answer: "Example: change it", answerReason: "rule: named rule" });
    const owner = (await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Example: which name?", recommendation: "Example: keep it", key: "secret/token" },
      s,
      "owner",
    )) as Record<string, unknown>;
    expect(owner).toMatchObject({ decision: "held", act: "ask", red: null });
    expect(owner.answeredBy).toBeUndefined();
    expect(s.holds.has("hivra-chat")).toBe(false);
    const money = (await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Example: keep the gate?", recommendation: "Example: keep it", key: "spend" },
      s,
      "money",
    )) as Record<string, unknown>;
    expect(money).toMatchObject({ decision: "held", act: "ask" });
    expect(money.answeredBy).toBeUndefined();
    expect(String(money.reason)).toContain("limit");
  });

  it("a blank captain id is not the asking Mono", async () => {
    const s = setup();
    await on(s, ["*"]);
    s.deps.captainContext = () => ({ monoId: "   ", standing: { answer: "Example: keep it", label: "merge on green" } });
    const taken = await call(
      chat("hivra-chat"),
      "autopilot.decide",
      {
        question: "Example: keep the gate?",
        recommendation: "Example: change it",
        options: ["Example: keep it", "Example: change it"],
      },
      s,
      "blank-chief",
    );
    expect(taken).toMatchObject({ decision: "taken", answeredBy: "captain:chief" });
    expect((taken as { answeredBy?: string }).answeredBy).not.toBe("captain:hivra-lead");
  });

  it("does not answer a keyed call from another project's rule or standing answer", async () => {
    const s = setup();
    await on(s, ["*"]);
    const seen: unknown[] = [];
    s.deps.captainContext = (input) => {
      seen.push(input.key);
      return {
        rules: [{ when: "font", answer: "Example: Inter" }],
        standing: { answer: "Example: Inter", label: "EXO menus" },
      };
    };
    const worker = chat("worker-1", [], "/Users/someone/Projects/hivra");
    const result = (await call(
      worker,
      "autopilot.decide",
      {
        question: "Which font?",
        recommendation: "Example: Comic Sans",
        project: "EXO",
        key: "font/menu",
        options: ["Example: Inter", "Example: Comic Sans"],
      },
      s,
      "outsider",
    )) as Record<string, unknown>;
    expect(result.decision).toBe("held");
    expect(result.answeredBy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Example: Inter");
    expect(JSON.stringify(result)).not.toContain("EXO menus");
    expect(seen).toEqual([undefined]);
  });

  it("passes the card version it read, and does not write when that version is missing", async () => {
    const s = setup();
    await on(s, ["*"]);
    const written: unknown[][] = [];
    s.deps.captainContext = () => ({
      monoId: "ada",
      standing: { answer: "Keep it", label: "merge on green" },
    });
    s.deps.answerDecision = async (...args) => {
      written.push(args);
      return { applied: true };
    };
    const card = {
      question: "Which font?",
      options: ["Keep it", "Change it"],
      recommended: "Keep it",
      askedBy: "fm",
      state: "open" as const,
      version: 4,
    };
    s.deps.openCard = async () => card;
    const taken = await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Which font?", recommendation: "Change it", project: "Hivra", key: "font" },
      s,
      "ver",
    );
    expect(taken).toMatchObject({ decision: "taken", answer: "Keep it" });
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe("hivra");
    expect(written[0]?.[1]).toBe("font");
    expect(written[0]?.[2]).toBe("Keep it");
    expect(written[0]?.[4]).toBe(4);
    expect(written[0]?.[6]).toBe("hivra-chat");

    s.deps.openCard = async () => ({ ...card, version: undefined });
    const missing = (await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Which font?", recommendation: "Change it", project: "Hivra", key: "font" },
      s,
      "miss",
    )) as Record<string, unknown>;
    expect(missing.decision).toBe("held");
    expect(written).toHaveLength(1);

    s.deps.openCard = async () => ({ ...card, version: Number.NaN });
    const notANumber = (await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Which font?", recommendation: "Change it", project: "Hivra", key: "font" },
      s,
      "nan",
    )) as Record<string, unknown>;
    expect(notANumber.decision).toBe("held");
    expect(written).toHaveLength(1);

    delete s.deps.openCard;
    const unversioned = await call(
      chat("hivra-chat"),
      "autopilot.decide",
      { question: "Which font?", recommendation: "Change it", project: "Hivra", key: "font" },
      s,
      "none",
    );
    expect(unversioned).toMatchObject({ decision: "taken", answer: "Keep it" });
    expect(written).toHaveLength(2);
    expect(written[1]?.[4]).toBeUndefined();
  });

  it("status says what is on, for whom", async () => {
    const s = setup();
    await on(s, ["hivra"]);
    expect(await call(chat("hivra-chat"), "autopilot.status", {}, s)).toMatchObject({ on: true, for: "Hivra", untilLabel: "Mon 9:00" });
    expect(await call(chat("cos-chat"), "autopilot.status", {}, s)).toMatchObject({ on: false });
  });
});

describe("a standing answer kept after a failed fetch", () => {
  const row = { answer: "Example: keep it", label: "merge on green" };
  it("is used while it is fresh, and dropped once it is older than a minute", () => {
    expect(standingFromCache(undefined, 1_000)).toBeNull();
    expect(standingFromCache({ at: Number.NaN, row }, 1_000)).toBeNull();
    expect(standingFromCache({ at: 1_000, row }, 1_000 + 59_999)).toEqual(row);
    expect(standingFromCache({ at: 1_000, row }, 1_000 + 60_000)).toBeNull();
  });
});

describe("the app control", () => {
  it("routes autopilot.* and rejects unknown fields", async () => {
    const appHost = { isMono: () => false } as unknown as AgentAppHost;
    await expect(handleAgentApp(chat("w"), "r", "autopilot.decide", { question: "q", recommendation: "r", bogus: 1 }, appHost)).rejects.toThrow(
      "Unknown autopilot.decide fields: bogus",
    );
    // Outside the desktop app there is no store.
    await expect(handleAgentApp(chat("w"), "r", "autopilot.status", {}, appHost)).rejects.toThrow("Autopilot needs the desktop app.");
  });
});

describe("the captain in the app's own autopilot (review of PR #244)", () => {
  it("the deps the app runs with give the captain its context, so money past the limit can pass up", () => {
    // handleAgentApp calls handleAutopilotApp with defaultAutopilotDeps(). Without captainContext, captainDecide never
    // sees moneyOverLimit, a rule, a standing answer or a turn count, and step 5 takes every recommendation.
    const deps = defaultAutopilotDeps();
    expect(deps.captainContext).toBeTypeOf("function");
  });
});
