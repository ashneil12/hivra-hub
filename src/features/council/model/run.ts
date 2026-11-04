// WP-23: one council run. The model only answers. Who speaks, what they are allowed to see, and what counts are decided here.
import {
  anonymise,
  blindPrompt,
  capAnswer,
  chooseChairman,
  crossPrompt,
  fallbackVerdict,
  minorityReport,
  parseStance,
  parseVerdict,
  retryPrompt,
  seatNeedles,
  STANCE_SHAPE,
  stancePrompt,
  tally,
  VERDICT_SHAPE,
  verdictPrompt,
  type CouncilSeat,
  type ParseResult,
  type PersonaBrief,
  type Stance,
  type Tally,
  type Verdict,
} from "./protocol";

export type CouncilRoundName = "blind" | "cross" | "stance" | "verdict";

/** What one seat's engine returns. A throw, a timeout or an empty reply is not the end of the council. */
export type CouncilModel = (input: {
  seatId: string;
  round: CouncilRoundName;
  prompt: string;
  signal: AbortSignal;
}) => Promise<{ text: string; tokens?: number }>;

export type CouncilAnswer = { seatId: string; member: string; text: string };

export type CouncilRun = {
  phase: "done" | "stopped";
  round?: CouncilRoundName;
  blind: CouncilAnswer[];
  cross: CouncilAnswer[];
  stances: Stance[];
  retried: string[];
  skipped: string[];
  tally?: Tally;
  verdict?: Verdict;
  chairmanId?: string;
  chairmanDifferent?: boolean;
  calls: number;
  /** Set only when every call reported a token count. */
  tokens?: number;
  tokensComplete: boolean;
  rounds: number;
};

export async function runCouncil(input: {
  question: string;
  seats: readonly CouncilSeat[];
  personas: ReadonlyMap<string, PersonaBrief>;
  model: CouncilModel;
  signal: AbortSignal;
  /** False once this run is no longer the one on screen (a newer run, or the view went away). Later results are dropped. */
  isCurrent?: () => boolean;
  onProgress?: (partial: CouncilRun) => void;
}): Promise<CouncilRun> {
  const stats = { calls: 0, tokens: 0, tokensComplete: true };
  const retried: string[] = [];
  const skipped: string[] = [];
  const run: CouncilRun = {
    phase: "done",
    blind: [],
    cross: [],
    stances: [],
    retried,
    skipped,
    calls: 0,
    tokensComplete: false,
    rounds: 0,
  };

  const stopped = () => input.signal.aborted || input.isCurrent?.() === false;

  const note = (text: { tokens?: number } | "missing") => {
    if (text === "missing" || typeof text.tokens !== "number") stats.tokensComplete = false;
    else stats.tokens += text.tokens;
  };

  async function once(seatId: string, round: CouncilRoundName, prompt: string): Promise<{ text: string; tokens?: number } | "again" | "stopped"> {
    if (stopped()) return "stopped";
    stats.calls += 1;
    try {
      const out = await Promise.race([input.model({ seatId, round, prompt, signal: input.signal }), listen(input.signal)]);
      if (stopped()) return "stopped";
      if (!out || typeof out.text !== "string") {
        note("missing");
        return { text: "" };
      }
      const tokens = typeof out.tokens === "number" && Number.isInteger(out.tokens) && out.tokens >= 0 ? out.tokens : undefined;
      note(tokens === undefined ? "missing" : { tokens });
      return { text: capAnswer(out.text), ...(tokens !== undefined ? { tokens } : {}) };
    } catch (error) {
      if (isAbort(error) || stopped()) return "stopped";
      return "again";
    }
  }

  /** One transport failure is tried again with the same prompt. A second failure skips the seat for this round. */
  async function call(seatId: string, round: CouncilRoundName, prompt: string): Promise<{ text: string; tokens?: number } | "skipped" | "stopped"> {
    const first = await once(seatId, round, prompt);
    if (first === "stopped") return "stopped";
    if (first !== "again") return first;
    const second = await once(seatId, round, prompt);
    if (second === "again") return "skipped";
    return second;
  }

  async function shaped<T>(seatId: string, round: CouncilRoundName, prompt: string, shape: string, parse: (text: string) => ParseResult<T>): Promise<{ value: T } | "skipped" | "stopped"> {
    const first = await call(seatId, round, prompt);
    if (first === "stopped" || first === "skipped") return first;
    const parsed = parse(first.text);
    if (parsed.ok) return { value: parsed.value };
    if (!retried.includes(seatId)) retried.push(seatId);
    const second = await call(seatId, round, retryPrompt(shape, parsed.problem));
    if (second === "stopped" || second === "skipped") return second;
    const again = parse(second.text);
    return again.ok ? { value: again.value } : "skipped";
  }

  function publish(round: CouncilRoundName): boolean {
    if (stopped()) return false;
    run.round = round;
    run.calls = stats.calls;
    run.retried = [...retried];
    run.skipped = [...skipped];
    try {
      input.onProgress?.({ ...run, blind: [...run.blind], cross: [...run.cross], stances: [...run.stances] });
    } catch {
      /* a view that fails to draw does not stop the council */
    }
    return !stopped();
  }

  const plain = (text: string): ParseResult<string> => (text.trim() ? { ok: true, value: text } : { ok: false, problem: "it was empty." });
  const needles = input.seats.map((seat) => ({
    member: seat.member,
    needles: seatNeedles(seat, seat.personaId ? input.personas.get(seat.personaId)?.name : undefined),
  }));

  const blind = await Promise.all(
    input.seats.map(async (seat) => {
      const persona = seat.personaId ? input.personas.get(seat.personaId) : undefined;
      const result = await shaped(seat.id, "blind", blindPrompt(input.question, persona), "A plain answer, and nothing else.", plain);
      return { seat, result };
    }),
  );
  if (blind.some((item) => item.result === "stopped") || stopped()) return finish(run, stats, "stopped");
  for (const item of blind) {
    if (item.result === "skipped") skipped.push(item.seat.id);
    else if (item.result !== "stopped") run.blind.push({ seatId: item.seat.id, member: item.seat.member, text: item.result.value });
  }
  run.rounds = 1;
  if (!publish("blind")) return finish(run, stats, "stopped");

  const blindShown = run.blind.map((answer) => ({ member: answer.member, text: anonymise(answer.text, needles) }));
  const cross = await Promise.all(
    input.seats.map(async (seat) => {
      const prompt = anonymise(crossPrompt(input.question, seat.member, blindShown), needles);
      const result = await shaped(seat.id, "cross", prompt, "A plain answer, and nothing else.", plain);
      return { seat, result };
    }),
  );
  if (cross.some((item) => item.result === "stopped") || stopped()) return finish(run, stats, "stopped");
  for (const item of cross) {
    if (item.result === "skipped") skipped.push(item.seat.id);
    else if (item.result !== "stopped") run.cross.push({ seatId: item.seat.id, member: item.seat.member, text: anonymise(item.result.value, needles) });
  }
  run.rounds = 2;
  if (!publish("cross")) return finish(run, stats, "stopped");

  const crossShown = run.cross.map((answer) => ({ member: answer.member, text: answer.text }));
  const positions = await Promise.all(
    input.seats.map(async (seat) => {
      const prompt = anonymise(stancePrompt(input.question, seat.member, blindShown, crossShown), needles);
      const result = await shaped(seat.id, "stance", prompt, STANCE_SHAPE, parseStance);
      return { seat, result };
    }),
  );
  if (positions.some((item) => item.result === "stopped") || stopped()) return finish(run, stats, "stopped");
  for (const item of positions) {
    if (item.result === "skipped") skipped.push(item.seat.id);
    else if (item.result !== "stopped") {
      run.stances.push({
        seatId: item.seat.id,
        member: item.seat.member,
        weight: item.seat.weight,
        option: item.result.value.option,
        confidence: item.result.value.confidence,
        reason: item.result.value.reason,
        ...(item.result.value.factor !== undefined ? { factor: item.result.value.factor } : {}),
        ...(item.result.value.dealbreaker ? { dealbreaker: true } : {}),
      });
    }
  }
  run.tally = tally(run.stances, input.seats);
  run.rounds = 3;
  if (!publish("stance")) return finish(run, stats, "stopped");

  const chair = chooseChairman(input.seats);
  const report = minorityReport(run.tally);
  if (chair) {
    run.chairmanId = chair.seatId;
    run.chairmanDifferent = chair.differentProvider;
    const result = await shaped(
      chair.seatId,
      "verdict",
      verdictPrompt(input.question, run.tally, report, { blind: run.blind, cross: run.cross, stances: run.stances }),
      VERDICT_SHAPE,
      parseVerdict,
    );
    if (result === "stopped" || stopped()) return finish(run, stats, "stopped");
    if (result === "skipped") run.verdict = fallbackVerdict(run.tally, report);
    else run.verdict = { ...result.value, minority: report, fromChairman: true };
  } else {
    run.verdict = fallbackVerdict(run.tally, report);
  }
  run.rounds = 4;
  return finish(run, stats, "done");
}

function finish(run: CouncilRun, stats: { calls: number; tokens: number; tokensComplete: boolean }, phase: "done" | "stopped"): CouncilRun {
  const tokensComplete = stats.tokensComplete && stats.calls > 0;
  return {
    ...run,
    phase,
    calls: stats.calls,
    tokensComplete,
    ...(tokensComplete ? { tokens: stats.tokens } : {}),
    retried: [...run.retried],
    skipped: [...run.skipped],
  };
}

function listen(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("The council was stopped.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
