import { expect, it } from "vitest";
import { seatPanel, type CouncilEngine } from "./protocol";
import { runCouncil, type CouncilModel } from "./run";

const panel: CouncilEngine[] = [
  { cli: "claude", family: "Anthropic", label: "Claude Code" },
  { cli: "codex", family: "OpenAI", label: "Codex" },
  { cli: "grok", family: "xAI", label: "Grok Build" },
];

function seats(extra: CouncilEngine[] = []) {
  return seatPanel(
    [...panel, ...extra].map((engine, index) => ({ ...engine, ...(index === 0 ? { personaId: "skeptic" } : {}) })),
    new Map([["skeptic", 1]]),
    "room",
  );
}

const personas = new Map([["skeptic", { id: "skeptic", name: "Skeptic", text: "Doubt the easy answer." }]]);

function stance(option: string, confidence = 80) {
  return `OPTION: ${option}\nCONFIDENCE: ${confidence}\nREASON: One line.`;
}

function verdict(step = "Publish the page.") {
  return ["UNRESOLVED:", "None", "KILL CRITERIA:", "None", "NEXT STEP:", step, "MINORITY REPORT:", "The chair wrote this and it must not be kept."].join("\n");
}

it("keeps the blind round isolated, hides names, and retries one bad stance", async () => {
  // Two Anthropic seats and one OpenAI seat: the chair has to be the OpenAI seat.
  const room = seatPanel(
    [
      { cli: "claude", family: "Anthropic", label: "Claude Code", personaId: "skeptic" },
      { cli: "pi", family: "Anthropic", label: "Pi" },
      { cli: "codex", family: "OpenAI", label: "Codex" },
    ],
    new Map([["skeptic", 1]]),
    "room",
  );
  let inFlight = 0;
  let max = 0;
  const seen = new Map<string, string[]>();
  const calls = new Map<string, number>();
  const stanceTries = new Map<string, number>();
  const model: CouncilModel = async (input) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    calls.set(input.seatId, (calls.get(input.seatId) ?? 0) + 1);
    seen.set(input.seatId, [...(seen.get(input.seatId) ?? []), input.prompt]);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (input.round === "blind") {
      const seat = room.find((s) => s.id === input.seatId)!;
      return { text: `SECRET-${seat.member} via ${seat.label}`, tokens: 3 };
    }
    if (input.round === "cross") return { text: "I challenge Member B.", tokens: 1 };
    if (input.round === "stance") {
      const n = (stanceTries.get(input.seatId) ?? 0) + 1;
      stanceTries.set(input.seatId, n);
      if (input.seatId === room[0].id && n === 1) return { text: "not a stance", tokens: 1 };
      if (input.seatId === room[0].id) return { text: stance("Wait", 40), tokens: 1 };
      return { text: stance("Ship"), tokens: 1 };
    }
    return { text: verdict(), tokens: 2 };
  };
  const result = await runCouncil({ question: "Should we ship?", seats: room, personas, model, signal: new AbortController().signal });

  expect(max).toBe(room.length);
  for (const [id, prompts] of seen) {
    const blind = prompts[0];
    expect(blind).not.toMatch(/SECRET-/);
    for (const other of room) if (other.id !== id) expect(blind).not.toContain(other.label);
  }
  const cross = seen.get(room[0].id)![1];
  expect(cross).toContain("Member B");
  expect(cross).toContain("SECRET-Member B");
  expect(cross).not.toMatch(/Pi|Claude Code|Skeptic|Anthropic|Codex/);

  expect(seen.get(room[0].id)!.some((prompt) => prompt.includes("not in the right shape"))).toBe(true);
  expect(stanceTries.get(room[0].id)).toBe(2);
  expect(calls.get(room[0].id)).toBe(4);
  expect(result.retried).toContain(room[0].id);
  expect(result.phase).toBe("done");
  expect(result.tally?.consensus).toBe(true);
  expect(result.tally?.winner).toBe("Ship");
  expect(result.tally?.minority.map((s) => s.member)).toEqual(["Member A"]);
  expect(result.verdict?.minority).toMatch(/Member A — Wait/);
  expect(result.verdict?.minority).not.toMatch(/must not be kept/);
  expect(result.verdict?.fromChairman).toBe(true);
  expect(result.chairmanDifferent).toBe(true);
  expect(result.chairmanId).toBe(room[2].id);
  expect(result.tokens).toBeGreaterThan(0);
});

it("does not treat a timeout as the end of the council", async () => {
  const room = seats();
  const tries = new Map<string, number>();
  const model: CouncilModel = async (input) => {
    const n = (tries.get(`${input.seatId}:${input.round}`) ?? 0) + 1;
    tries.set(`${input.seatId}:${input.round}`, n);
    if (input.seatId === room[0].id && input.round === "blind") throw new Error("timed out");
    if (input.round === "stance") return { text: stance(input.seatId === room[1].id ? "Wait" : "Ship") };
    if (input.round === "verdict") return { text: verdict() };
    return { text: "A point." };
  };
  const result = await runCouncil({ question: "Ship?", seats: room, personas, model, signal: new AbortController().signal });
  expect(tries.get(`${room[0].id}:blind`)).toBe(2);
  expect(result.phase).toBe("done");
  expect(result.blind.map((a) => a.seatId)).not.toContain(room[0].id);
  expect(result.skipped).toContain(room[0].id);
  expect(result.verdict?.nextStep).toBe("Publish the page.");
});

it("a bad verdict is asked once, then the tally stands, and 3 of 5 is no consensus", async () => {
  const room = seats([
    { cli: "hermes", family: "Hermes", label: "Hermes Agent" },
    { cli: "pi", family: "Pi", label: "Pi" },
  ]);
  let verdicts = 0;
  const model: CouncilModel = async (input) => {
    if (input.round === "stance") {
      const option = room.slice(0, 3).some((s) => s.id === input.seatId) ? "Ship" : input.seatId === room[3].id ? "Wait" : "Hold";
      return { text: stance(option) };
    }
    if (input.round === "verdict") {
      verdicts += 1;
      return { text: verdicts === 1 ? "nope" : "still nope" };
    }
    return { text: "Noted." };
  };
  const result = await runCouncil({ question: "Ship?", seats: room, personas, model, signal: new AbortController().signal });
  expect(verdicts).toBe(2);
  expect(result.tally?.consensus).toBe(false);
  expect(result.verdict?.fromChairman).toBe(false);
  expect(result.verdict?.nextStep).toMatch(/No consensus/);
  expect(result.verdict?.minority).toMatch(/No consensus/);
  expect(result.chairmanDifferent).toBe(true);
  expect(result.phase).toBe("done");
});

it("drops a late answer once the run is stopped", async () => {
  const room = seats().slice(0, 2);
  let release: (value: { text: string }) => void = () => {};
  const gate = new Promise<{ text: string }>((resolve) => {
    release = resolve;
  });
  const model: CouncilModel = () => gate;
  const ac = new AbortController();
  const pending = runCouncil({ question: "Ship?", seats: room, personas, model, signal: ac.signal });
  ac.abort();
  release({ text: "too late SECRET-should-not-land" });
  const result = await pending;
  expect(result.phase).toBe("stopped");
  expect(result.blind).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("SECRET-should-not-land");
});
