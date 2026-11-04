import { expect, it } from "vitest";
import {
  anonymise,
  blindPrompt,
  chooseChairman,
  crossPrompt,
  expectedCalls,
  fallbackVerdict,
  memberLabel,
  minorityReport,
  parseStance,
  parseVerdict,
  proposePanel,
  reachesTwoThirds,
  retryPrompt,
  seatNeedles,
  seatPanel,
  stancePrompt,
  tally,
  verdictPrompt,
  type CouncilEngine,
  type CouncilSeat,
  type Stance,
} from "./protocol";

const engines: CouncilEngine[] = [
  { cli: "claude", family: "Anthropic", label: "Claude Code" },
  { cli: "codex", family: "OpenAI", label: "Codex" },
  { cli: "grok", family: "xAI", label: "Grok Build" },
  { cli: "pi", family: "Anthropic", label: "Pi" },
  { cli: "hermes", family: "Hermes", label: "Hermes Agent" },
];

function stance(partial: Partial<Stance> & Pick<Stance, "option">): Stance {
  return {
    seatId: partial.seatId ?? partial.option,
    member: partial.member ?? partial.option,
    option: partial.option,
    confidence: partial.confidence ?? 50,
    reason: partial.reason ?? "Because.",
    weight: partial.weight ?? 1,
    ...(partial.factor !== undefined ? { factor: partial.factor } : {}),
    ...(partial.dealbreaker ? { dealbreaker: true } : {}),
  };
}

it("proposes one seat per engine and family, and says how many calls that is", () => {
  const full = proposePanel(engines, "full");
  expect(full.seats.map((s) => s.cli)).toEqual(["claude", "codex", "grok", "pi", "hermes"]);
  expect(full.expectedCalls).toBe(16);
  expect(full.note).toBeUndefined();

  const triad = proposePanel(engines, "triad");
  expect(triad.seats.map((s) => s.family)).toEqual(["Anthropic", "OpenAI", "xAI"]);
  expect(triad.expectedCalls).toBe(10);

  expect(expectedCalls(2)).toBe(7);
  expect(expectedCalls(0)).toBe(0);
  expect(expectedCalls(-1)).toBe(0);
});

it("shrinks the panel when fewer engines are available, and drops blanks and duplicates", () => {
  const short = proposePanel(engines.slice(0, 2), "triad");
  expect(short.seats).toHaveLength(2);
  expect(short.expectedCalls).toBe(7);
  expect(short.note).toMatch(/Triad asks for 3 seats/);

  const dupes = proposePanel(
    [
      engines[0],
      { ...engines[0], label: "again" },
      { cli: "  ", family: "OpenAI", label: "Codex" },
      { cli: "codex", family: "  ", label: "Codex" },
      engines[1],
    ],
    "full",
  );
  expect(dupes.seats.map((s) => s.cli)).toEqual(["claude", "codex"]);

  const none = proposePanel([], "quick");
  expect(none.seats).toEqual([]);
  expect(none.expectedCalls).toBe(0);
  expect(none.note).toMatch(/No engine is signed in/);
});

it("hides real names behind member letters, longer names first", () => {
  const seats = [
    { member: "Member A", needles: ["Claude Code", "Claude", "Ada", "A"] },
    { member: "Member B", needles: ["Codex"] },
  ];
  const hidden = anonymise("Ada says Claude Code beat Claude, and Codex agrees. Claudette stays.", seats);
  expect(hidden).toBe("Member A says Member A beat Member A, and Member B agrees. Claudette stays.");
  expect(hidden).not.toMatch(/\b(?:Ada|Claude|Codex)\b/);
});

it("a blind prompt carries no other seat", () => {
  const prompt = blindPrompt("Should we ship?", { id: "skeptic", name: "Skeptic", text: "Doubt it.", method: "formal-stepwise-verification" });
  expect(prompt).toContain("Should we ship?");
  expect(prompt).toContain("Skeptic");
  expect(prompt).toContain("Doubt it.");
  expect(prompt).toContain("Do NOT try to anticipate what other members will say.");
  expect(prompt).toContain("Limit: 400 words maximum.");
  expect(prompt).toContain("formal-stepwise-verification");
  expect(prompt).not.toMatch(/Member [A-Z]|Codex|SECRET-/);
  expect(blindPrompt("Ship?", undefined)).not.toContain("Your role is");
});

it("the cross-exam names members and not engines", () => {
  const seat = seatPanel([{ cli: "claude", family: "Anthropic", label: "Claude Code", personaId: "skeptic" }], new Map(), "room")[0];
  const prompt = crossPrompt("Ship?", seat.member, [{ member: "Member B", text: "SECRET-b says Ada uses claude." }]);
  expect(prompt).toContain("Anti-conformity directive.");
  expect(prompt).toContain("Limit: 300 words maximum. You MUST engage at least 2 other members by label.");
  const hidden = anonymise(prompt, [{ member: seat.member, needles: seatNeedles(seat, "Skeptic") }]);
  expect(hidden).toContain("Member B");
  expect(hidden).toContain("SECRET-b");
  expect(hidden).not.toMatch(/claude|Anthropic|Claude Code|Skeptic/i);
});

it("parses a stance only when it is exactly three lines, and retries in those words", () => {
  expect(parseStance("OPTION: Ship\nCONFIDENCE: 80\nREASON: The price is set.")).toEqual({
    ok: true,
    value: { option: "Ship", confidence: 80, reason: "The price is set." },
  });
  expect(parseStance("option: Ship\r\nconfidence: 0\r\nreason: Wait.")).toMatchObject({ ok: true, value: { confidence: 0 } });
  expect(parseStance("OPTION: Ship\nCONFIDENCE: 80\nREASON: One.\n")).toMatchObject({ ok: true });
  for (const bad of [
    "hello",
    "OPTION: Ship\nREASON: x\nCONFIDENCE: 1",
    "OPTION: Ship\nCONFIDENCE: 101\nREASON: x",
    "OPTION: Ship\nCONFIDENCE: many\nREASON: x",
    "OPTION: \nCONFIDENCE: 1\nREASON: x",
    "```\nOPTION: Ship\nCONFIDENCE: 1\nREASON: x\n```",
  ]) {
    const parsed = parseStance(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(retryPrompt("OPTION:", parsed.problem)).toContain(parsed.problem);
  }

  expect(parseStance("I think we should ship it, strongly.")).toMatchObject({ ok: false });
  expect(parseStance("Weighing it up.\nSTANCE: ship now | CONFIDENCE: high | DEALBREAKER: no")).toEqual({
    ok: true,
    value: { option: "ship now", confidence: 100, reason: "Not a dealbreaker.", factor: 1, dealbreaker: false },
  });
  expect(parseStance("STANCE: monorepo | CONFIDENCE: med | DEALBREAKER: yes")).toMatchObject({
    ok: true,
    value: { option: "monorepo", confidence: 75, factor: 0.75, dealbreaker: true, reason: "Dealbreaker." },
  });
  expect(parseStance("STANCE: hold | CONFIDENCE: low | DEALBREAKER: no")).toMatchObject({ ok: true, value: { confidence: 50, factor: 0.5 } });
  expect(parseStance("STANCE: abstain")).toMatchObject({ ok: true, value: { option: "abstain", factor: 1, dealbreaker: false } });
  expect(parseStance("STANCE: abstain | CONFIDENCE: low | DEALBREAKER: yes")).toMatchObject({ ok: true, value: { option: "abstain", dealbreaker: false } });
  expect(parseStance("STANCE: ship | CONFIDENCE: many | DEALBREAKER: yes").ok).toBe(false);
  expect(parseStance("STANCE: ship").ok).toBe(false);
  expect(stancePrompt("Ship?", "Member A", [], [])).toContain("STANCE: <one short option label> | CONFIDENCE: high|med|low | DEALBREAKER: yes|no");
});

it("the two-thirds line is exact, and 3 of 5 is not enough", () => {
  expect(reachesTwoThirds(2, 3)).toBe(true);
  expect(reachesTwoThirds(1, 3)).toBe(false);
  expect(reachesTwoThirds(3, 5)).toBe(false);
  expect(reachesTwoThirds(4, 6)).toBe(true);
  expect(reachesTwoThirds(0, 0)).toBe(false);

  const won = tally(
    [
      stance({ option: "Ship", member: "Member A", seatId: "a" }),
      stance({ option: "Ship", member: "Member B", seatId: "b" }),
      stance({ option: "Wait", member: "Member C", seatId: "c" }),
    ],
    [{ id: "a", member: "Member A" }, { id: "b", member: "Member B" }, { id: "c", member: "Member C" }],
  );
  expect(won.consensus).toBe(true);
  expect(won.winner).toBe("Ship");
  expect(won.minority.map((s) => s.member)).toEqual(["Member C"]);
  expect(minorityReport(won)).toMatch(/Member C — Wait/);

  const split = tally([stance({ option: "Ship" }), stance({ option: "Wait" })], []);
  expect(split.consensus).toBe(false);
  expect(split.winner).toBeUndefined();
  expect(minorityReport(split)).toMatch(/^No consensus\n/);
  expect(split.minority).toHaveLength(2);

  const threeOfFive = tally(
    ["Ship", "Ship", "Ship", "Wait", "Hold"].map((option, i) => stance({ option, member: memberLabel(i), seatId: String(i) })),
    [],
  );
  expect(threeOfFive.consensus).toBe(false);
  expect(minorityReport(threeOfFive)).toMatch(/No consensus/);

  const weighted = tally(
    [stance({ option: "Ship", weight: 2, member: "Member A" }), stance({ option: "Wait", weight: 1, member: "Member B" })],
    [],
  );
  expect(weighted.consensus).toBe(true);
  expect(weighted.winner).toBe("Ship");

  const same = tally([stance({ option: "Ship" }), stance({ option: " ship " })], []);
  expect(same.options).toHaveLength(1);
  expect(same.options[0].weight).toBe(2);

  const quiet = tally([], [{ id: "a", member: "Member A" }]);
  expect(quiet.consensus).toBe(false);
  expect(quiet.abstained).toEqual(["Member A"]);
  expect(minorityReport(quiet)).toBe("No seat gave a final position.");

  const unanimous = tally([stance({ option: "Ship" }), stance({ option: "Ship" })], []);
  expect(unanimous.minority).toEqual([]);
  expect(minorityReport(unanimous)).toBe("No one disagreed.");
});

it("weights the vote by confidence, and an abstention still counts in the total", () => {
  // 1.5 at high plus 1.0 at med is 2.25. The bar for a base total of 3.5 is 2.333, so this does not clear.
  const almost = tally(
    [
      stance({ option: "Ship", weight: 1.5, confidence: 100, factor: 1, member: "Member A", seatId: "a" }),
      stance({ option: "Ship", weight: 1, confidence: 75, factor: 0.75, member: "Member B", seatId: "b" }),
      stance({ option: "abstain", weight: 1, member: "Member C", seatId: "c" }),
    ],
    [],
  );
  expect(almost.total).toBe(3.5);
  expect(almost.options[0].weight).toBe(2.25);
  expect(almost.consensus).toBe(false);
  expect(reachesTwoThirds(2.25, 3.5)).toBe(false);
  expect(almost.abstained).toEqual(["Member C"]);

  const exact = tally(
    [
      stance({ option: "Ship", member: "Member A", seatId: "a" }),
      stance({ option: "Ship", member: "Member B", seatId: "b" }),
      stance({ option: "abstain", member: "Member C", seatId: "c" }),
    ],
    [],
  );
  expect(exact.consensus).toBe(true);
  expect(exact.total).toBe(3);

  const low = tally(
    [
      stance({ option: "Ship", factor: 0.5, confidence: 50, member: "Member A", seatId: "a" }),
      stance({ option: "Ship", factor: 0.5, confidence: 50, member: "Member B", seatId: "b" }),
      stance({ option: "Wait", factor: 1, confidence: 100, member: "Member C", seatId: "c" }),
    ],
    [],
  );
  expect(low.total).toBe(3);
  expect(low.options.find((option) => option.option === "Ship")?.weight).toBe(1);
  expect(low.consensus).toBe(false);

  const blocked = tally(
    [
      stance({ option: "Ship", member: "Member A", seatId: "a", dealbreaker: true, reason: "Dealbreaker." }),
      stance({ option: "Wait", member: "Member B", seatId: "b" }),
      stance({ option: "Wait", member: "Member C", seatId: "c" }),
    ],
    [],
  );
  expect(blocked.consensus).toBe(true);
  expect(blocked.winner).toBe("Wait");
  expect(minorityReport(blocked)).toMatch(/Member A — Ship/);
  expect(minorityReport(blocked)).toMatch(/Dealbreaker/);

  const skipped = tally(
    [stance({ option: "Ship", member: "Member A", seatId: "a" }), stance({ option: "Ship", member: "Member B", seatId: "b" })],
    [{ id: "a", member: "Member A" }, { id: "b", member: "Member B" }, { id: "c", member: "Member C" }],
  );
  expect(skipped.total).toBe(3);
  expect(skipped.consensus).toBe(true);
  expect(skipped.abstained).toEqual(["Member C"]);
});

it("the chair is a different provider when one is seated, and still a seat when none is", () => {
  const mixed = [
    { id: "a", family: "Anthropic" },
    { id: "b", family: "Anthropic" },
    { id: "c", family: "Anthropic" },
    { id: "d", family: "OpenAI" },
    { id: "e", family: "xAI" },
  ];
  expect(chooseChairman(mixed)).toEqual({ seatId: "d", differentProvider: true });
  expect(chooseChairman([{ id: "a", family: "Anthropic" }, { id: "b", family: "Anthropic" }])).toEqual({
    seatId: "b",
    differentProvider: false,
  });
  expect(chooseChairman([])).toBeUndefined();
});

it("a verdict has the four headings in order, and one next step", () => {
  const good = ["UNRESOLVED:", "None", "KILL CRITERIA:", "A refund spike.", "NEXT STEP:", "Publish the page.", "MINORITY REPORT:", "Member C waited."].join("\n");
  expect(parseVerdict(good)).toMatchObject({ ok: true, value: { nextStep: "Publish the page.", unresolved: "None" } });
  expect(parseVerdict(`note\n${good}`).ok).toBe(false);
  expect(parseVerdict(good.replace("NEXT STEP:\nPublish the page.", "NEXT STEP:\nPublish the page.\nAnd another.")).ok).toBe(false);
  expect(parseVerdict(good.replace("KILL CRITERIA:\n", "")).ok).toBe(false);

  const result = tally([stance({ option: "Ship" })], []);
  const report = minorityReport(result);
  const prompt = verdictPrompt("Ship?", result, report, {
    blind: [{ member: "Member A", text: "Ship it." }],
    cross: [{ member: "Member A", text: "Still shipping." }],
    stances: [stance({ option: "Ship", member: "Member A" })],
  });
  expect(prompt).toContain("You are the Chairman of the Council of High Intelligence.");
  expect(prompt).toContain("Lead with what the council does NOT know (Unresolved Questions).");
  expect(prompt).toContain("The tally below is final");
  expect(prompt).toContain("Ship it.");
  expect(prompt).toContain(report);
  const fallback = fallbackVerdict(result, report);
  expect(fallback.fromChairman).toBe(false);
  expect(fallback.minority).toBe(report);
  expect(fallback.nextStep).toMatch(/Ship/);
});

it("seats a panel with a weight, a member letter and its own tab", () => {
  const seats: CouncilSeat[] = seatPanel(
    [{ cli: "claude", family: "Anthropic", label: "Claude Code", personaId: "skeptic" }],
    new Map([["skeptic", 2]]),
    "room 1",
  );
  expect(seats[0]).toMatchObject({ member: "Member A", weight: 2, sessionId: "council:room 1:claude-anthropic-1" });
  const heavy = seatPanel([{ cli: "claude", family: "Anthropic", label: "Claude Code", personaId: "nope" }], new Map([["nope", 40]]), "r");
  expect(heavy[0].weight).toBe(1);
});
