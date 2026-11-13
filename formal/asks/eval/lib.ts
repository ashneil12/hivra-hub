// The ask extraction eval (formal/asks/README.md, part A). "A long rant never loses an ask" cannot be proved, because
// what counts as an ask is a judgement. It can be measured: ten long, messy messages with a hand-labelled list of what
// was asked, run through the code the app runs when a message of Ash's reaches a first mate, and scored.
//
// The code path is the app's own. The pure steps are imported, not copied: src/features/asks/model/asks.ts (the rules
// reading, the prompt, the reply check, the safety net, withHeard) and askStore.ts (the revision-checked document, on
// the in-memory disk the app's tests use). The one thing that cannot be imported is the body of the effect inside
// useAskLedger (a React hook): hearLikeApp below follows it line for line, and
// src/features/asks/testbed/askEval.test.ts renders the real hook and fails if the two ever disagree.
//
// The model call is an injected function `(prompt) => Promise<string>`: the app's own is isolatedCompaction (a Claude
// text call, src/app/hooks/useMonoTrees.ts). Here it is a recording, an oracle, a command, or nothing.
//
// Not wired into CI. Run it with `node formal/asks/eval/run.mjs`, or through the vitest file above.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isLongMessage, worthKeeping } from "../../../src/features/asks/hooks/useAskLedger";
import { createAskStore, type AskStore } from "../../../src/features/asks/model/askStore";
import { hearMessage, hearPrompt, nothingToHear, parseHeard, quoteIn, rulesAsks, type Ask, type AskKind } from "../../../src/features/asks/model/asks";
import { extractAsks } from "../../../src/features/hub/model/askLedger";
import { memoryDisk } from "../../../src/features/hub/model/localHub/localHub";

/** Mirrors `MODEL_TRIES` in useAskLedger.ts (not exported there). The parity test reads the source and checks it. */
export const MODEL_TRIES = 2;

export type LabelledAsk = {
  id: string;
  kind: AskKind;
  gist: string;
  anchor: string;
  implicit?: boolean;
  buried?: boolean;
  cancelled?: boolean;
  withdrawnBy?: string;
};
export type EvalMessage = {
  id: string;
  shape: string;
  text: string;
  asks: LabelledAsk[];
  duplicates?: Array<{ of: string; anchor: string }>;
  notAsks?: Array<{ anchor: string; why: string }>;
};
export type Corpus = { about: string; messages: EvalMessage[] };

/** A model reply as stored in a recording: a list, raw text, or a failure. */
export type RecordedAnswer = { items?: unknown[]; raw?: string; error?: string; note?: string; promptSha?: string };
export type Recording = { provenance: string; answers: Record<string, RecordedAnswer> };

export type Ask$ = (prompt: string) => Promise<string>;

export type Attempt = { outcome: "ok" | "no-list" | "error"; detail?: string; items: number; kept: number };
export type Trace = { quickRows: number; keptInLedger: boolean; attempts: Attempt[]; heardBy: string; tries: number };

/** Items in the first [...] of a reply, the way parseHeard finds the list. 0 when there is none. */
export function replyItems(reply: string): number {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return 0;
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * One message of Ash's through what the app does with it, in the order useAskLedger.ts does it:
 *  1. the quick reading at once (rulesAsks), kept only when worthKeeping says so (the hook's `if (!mark)` branch);
 *  2. for a long message with a model call available, up to MODEL_TRIES model readings, each checked word for word and
 *     joined with the rules' safety net (hearMessage), the second only once the chat is quiet (the `mark.tries` gate).
 * `busy` says the chat is working when the second try comes round, so it is held back (the second try then never runs
 * in this one-shot, which is what the hook does while the turn lasts).
 */
export async function hearLikeApp(
  store: AskStore,
  input: { text: string; mateId: string; sessionId: string; blockId: string; ask?: Ask$; busy?: boolean; now: () => number },
): Promise<Trace> {
  const { text, mateId, sessionId, blockId, ask, busy = false, now } = input;
  const base = { mateId, sessionId, blockId };
  const quick = nothingToHear(text) ? [] : rulesAsks(text);
  const long = isLongMessage(text) && !nothingToHear(text);
  const keep = worthKeeping(text, quick, []);
  await store.hear({ ...base, list: { asks: keep ? quick : [], maybes: [] }, by: long && ask ? "rules" : keep ? "rules" : "model", now: now() });
  const trace: Trace = { quickRows: quick.length, keptInLedger: keep, attempts: [], heardBy: "", tries: 0 };
  for (let pass = 0; pass < 6; pass += 1) {
    const mark = store.doc().heard[blockId] ?? (await store.load()).heard[blockId];
    if (!mark || mark.by !== "rules" || !ask || !isLongMessage(text)) break;
    if (mark.tries > MODEL_TRIES || (mark.tries === MODEL_TRIES && busy)) break;
    const attempt: Attempt = { outcome: "ok", items: 0, kept: 0 };
    let heard: ReturnType<typeof parseHeard>;
    try {
      const reply = await ask(hearPrompt(text));
      attempt.items = replyItems(reply);
      heard = parseHeard(reply, text);
    } catch (error) {
      heard = undefined;
      attempt.outcome = "error";
      attempt.detail = error instanceof Error ? error.message : String(error);
    }
    if (!heard) {
      if (attempt.outcome === "ok") attempt.outcome = "no-list";
      const again = rulesAsks(text);
      await store.hear({ ...base, list: { asks: worthKeeping(text, again, []) ? again : [], maybes: [] }, by: "rules", now: now() });
    } else {
      attempt.kept = heard.length;
      const list = hearMessage(text, heard);
      const kept = worthKeeping(text, list.asks, list.maybes);
      await store.hear({ ...base, list: kept ? list : { asks: [], maybes: [] }, by: "model", now: now() });
    }
    trace.attempts.push(attempt);
  }
  const mark = store.doc().heard[blockId];
  trace.heardBy = mark?.by ?? "";
  trace.tries = mark?.tries ?? 0;
  return trace;
}

// ---- Scoring ----------------------------------------------------------------------------------------------------

/** A row holds an ask when its quote contains the anchor, or the anchor contains the quote. */
export function holds(row: Pick<Ask, "quote">, anchor: string): boolean {
  return quoteIn(anchor, row.quote) || quoteIn(row.quote, anchor);
}

export type AskResult = {
  id: string;
  anchor: string;
  gist: string;
  kind: AskKind;
  implicit: boolean;
  buried: boolean;
  /** separate: a real row of its own. merged: only in a row that also holds another ask. maybe: only as a "maybe" line. missed: nowhere. */
  found: "separate" | "merged" | "maybe" | "missed";
  rows: number;
  kindMatches?: boolean;
};
export type MessageResult = {
  id: string;
  shape: string;
  expected: number;
  asks: AskResult[];
  cancelledStillOpen: Array<{ id: string; anchor: string }>;
  duplicateRows: number;
  notAskRows: Array<{ anchor: string; as: "ask" | "maybe" }>;
  extraRows: string[];
  extraMaybes: string[];
  rows: number;
  trace: Trace;
};

/** What scoring needs of a row: the first-mate ledger's rows, or the hub ledger's (its `words` as the quote). */
export type Row = Pick<Ask, "quote" | "status" | "kind">;

export function scoreMessage(message: EvalMessage, rows: readonly Row[], trace: Trace): MessageResult {
  const real = rows.filter((row) => row.status !== "maybe" && row.status !== "dropped");
  const maybes = rows.filter((row) => row.status === "maybe");
  const live = message.asks.filter((ask) => !ask.cancelled);
  const asks: AskResult[] = live.map((ask) => {
    const hits = real.filter((row) => holds(row, ask.anchor));
    const separate = hits.filter((row) => !message.asks.some((other) => other.id !== ask.id && holds(row, other.anchor)));
    const duplicates = (message.duplicates ?? []).filter((dup) => dup.of === ask.id);
    const found: AskResult["found"] = separate.length ? "separate" : hits.length ? "merged" : maybes.some((row) => holds(row, ask.anchor)) ? "maybe" : "missed";
    const rowsFor = real.filter((row) => holds(row, ask.anchor) || duplicates.some((dup) => holds(row, dup.anchor)));
    return {
      id: ask.id,
      anchor: ask.anchor,
      gist: ask.gist,
      kind: ask.kind,
      implicit: !!ask.implicit,
      buried: !!ask.buried,
      found,
      rows: rowsFor.length,
      ...(separate.length ? { kindMatches: separate.some((row) => row.kind === ask.kind) } : {}),
    };
  });
  const everyAnchor = [
    ...message.asks.map((ask) => ask.anchor),
    ...message.asks.flatMap((ask) => (ask.withdrawnBy ? [ask.withdrawnBy] : [])),
    ...(message.duplicates ?? []).map((dup) => dup.anchor),
    ...(message.notAsks ?? []).map((item) => item.anchor),
  ];
  const known = (row: Row) => everyAnchor.some((anchor) => holds(row, anchor));
  return {
    id: message.id,
    shape: message.shape,
    expected: live.length,
    asks,
    cancelledStillOpen: message.asks
      .filter((ask) => ask.cancelled && real.some((row) => holds(row, ask.anchor)))
      .map((ask) => ({ id: ask.id, anchor: ask.anchor })),
    duplicateRows: asks.reduce((sum, ask) => sum + Math.max(0, ask.rows - 1), 0),
    notAskRows: (message.notAsks ?? []).flatMap((item) => [
      ...(real.some((row) => holds(row, item.anchor)) ? [{ anchor: item.anchor, as: "ask" as const }] : []),
      ...(maybes.some((row) => holds(row, item.anchor)) ? [{ anchor: item.anchor, as: "maybe" as const }] : []),
    ]),
    extraRows: real.filter((row) => !known(row)).map((row) => row.quote),
    extraMaybes: maybes.filter((row) => !known(row)).map((row) => row.quote),
    rows: rows.length,
    trace,
  };
}

export type Totals = {
  messages: number;
  expected: number;
  separate: number;
  merged: number;
  maybeOnly: number;
  missed: number;
  recallStrict: number;
  recallWithMaybes: number;
  implicit: { expected: number; separate: number };
  buried: { expected: number; separate: number };
  cancelledStillOpen: number;
  cancelledTotal: number;
  duplicateRows: number;
  notAskRows: number;
  extraRows: number;
  extraMaybes: number;
  kindAgrees: number;
  kindChecked: number;
  modelFailedBoth: number;
};

export function totals(results: readonly MessageResult[], corpus: Corpus): Totals {
  const all = results.flatMap((result) => result.asks);
  const count = (pick: (ask: AskResult) => boolean) => all.filter(pick).length;
  const expected = all.length;
  const separate = count((ask) => ask.found === "separate");
  const maybeOnly = count((ask) => ask.found === "maybe");
  const implicit = all.filter((ask) => ask.implicit);
  const buried = all.filter((ask) => ask.buried);
  return {
    messages: results.length,
    expected,
    separate,
    merged: count((ask) => ask.found === "merged"),
    maybeOnly,
    missed: count((ask) => ask.found === "missed"),
    recallStrict: expected ? separate / expected : 1,
    recallWithMaybes: expected ? (separate + maybeOnly) / expected : 1,
    implicit: { expected: implicit.length, separate: implicit.filter((ask) => ask.found === "separate").length },
    buried: { expected: buried.length, separate: buried.filter((ask) => ask.found === "separate").length },
    cancelledStillOpen: results.reduce((sum, result) => sum + result.cancelledStillOpen.length, 0),
    cancelledTotal: corpus.messages.reduce((sum, message) => sum + message.asks.filter((ask) => ask.cancelled).length, 0),
    duplicateRows: results.reduce((sum, result) => sum + result.duplicateRows, 0),
    notAskRows: results.reduce((sum, result) => sum + result.notAskRows.filter((row) => row.as === "ask").length, 0),
    extraRows: results.reduce((sum, result) => sum + result.extraRows.length, 0),
    extraMaybes: results.reduce((sum, result) => sum + result.extraMaybes.length, 0),
    kindAgrees: all.filter((ask) => ask.kindMatches === true).length,
    kindChecked: all.filter((ask) => ask.kindMatches !== undefined).length,
    modelFailedBoth: results.filter((result) => result.trace.attempts.length >= MODEL_TRIES && result.trace.attempts.every((attempt) => attempt.outcome !== "ok")).length,
  };
}

// ---- The model call: injected ---------------------------------------------------------------------------------------

/** hub: the other extractor, hub/model/askLedger.ts extractAsks (regex only, no model), which feeds the "You asked" list. */
export type Mode = "rules" | "oracle" | "recorded" | "live" | "hub";
export type AskOptions = {
  mode: Mode;
  recording?: Recording;
  liveCmd?: string;
  /** Called with each live reply, to be kept as a recording. */
  onLive?: (id: string, record: RecordedAnswer) => void;
  /** The first N calls for each message fail (a timeout), so the retry path is exercised. */
  failFirst?: number;
  /** The model only answers the first N items of its list: a model that names the loudest few. */
  lazy?: number;
};

const LIVE_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "SHELL"];

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The model call for one message, or undefined when the mode has none (the rules' reading stands alone). */
export function askFor(message: EvalMessage, options: AskOptions): Ask$ | undefined {
  if (options.mode === "rules" || options.mode === "hub") return undefined;
  let calls = 0;
  const shape = (reply: string): string => {
    if (options.lazy === undefined) return reply;
    const start = reply.indexOf("[");
    const end = reply.lastIndexOf("]");
    try {
      const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
      return JSON.stringify(Array.isArray(parsed) ? parsed.slice(0, options.lazy) : []);
    } catch {
      return reply;
    }
  };
  return async (prompt) => {
    calls += 1;
    if (options.failFirst !== undefined && calls <= options.failFirst) throw new Error("timed out (injected)");
    if (options.mode === "oracle") {
      const items = message.asks
        .filter((ask) => !ask.cancelled)
        .map((ask) => ({ quote: ask.anchor, summary: ask.gist, kind: ask.kind }));
      return shape(JSON.stringify(items));
    }
    if (options.mode === "recorded") {
      const answer = options.recording?.answers[message.id];
      if (!answer) throw new Error(`no recorded answer for ${message.id}`);
      if (answer.error) throw new Error(answer.error);
      if (answer.promptSha && answer.promptSha !== sha(prompt)) throw new Error(`recording for ${message.id} is for an older prompt`);
      return shape(answer.raw ?? JSON.stringify(answer.items ?? []));
    }
    // live: a command that reads the prompt on stdin and prints the reply
    if (!options.liveCmd) throw new Error("live mode needs a command");
    const env = Object.fromEntries(LIVE_ENV_KEYS.flatMap((key) => (process.env[key] ? [[key, process.env[key] as string]] : [])));
    const run = spawnSync(options.liveCmd, { shell: true, input: prompt, encoding: "utf8", timeout: 180_000, env });
    if (run.error || run.status !== 0) throw new Error(`live command failed: ${run.error?.message ?? run.stderr.slice(0, 200)}`);
    options.onLive?.(message.id, { raw: run.stdout, promptSha: sha(prompt) });
    return shape(run.stdout);
  };
}

// ---- Running ---------------------------------------------------------------------------------------------------------

export async function evaluate(corpus: Corpus, options: AskOptions): Promise<{ results: MessageResult[]; totals: Totals }> {
  const results: MessageResult[] = [];
  for (const message of corpus.messages) {
    if (options.mode === "hub") {
      // The hub ledger's reading of the message (dumpCheck.noteDumps calls recordAskText, which is extractAsks plus a row
      // per ask, deduped by askKey and capped at 400 rows overall: the per-message cap of 6 is inside extractAsks).
      const rows: Row[] = extractAsks(message.text).map((ask) => ({ quote: ask.words, status: "heard", kind: "do" }));
      results.push(scoreMessage(message, rows, { quickRows: rows.length, keptInLedger: rows.length > 0, attempts: [], heardBy: "hub-rules", tries: 0 }));
      continue;
    }
    let clock = 1_800_000_000_000;
    const store = createAskStore(memoryDisk(), () => (clock += 1000));
    await store.load();
    const trace = await hearLikeApp(store, {
      text: message.text,
      mateId: "mate",
      sessionId: `chat-${message.id}`,
      blockId: `blk-${message.id}`,
      ask: askFor(message, options),
      now: () => (clock += 1000),
    });
    results.push(scoreMessage(message, store.doc().asks, trace));
  }
  return { results, totals: totals(results, corpus) };
}

// ---- The report ------------------------------------------------------------------------------------------------------

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

export function describeMode(options: AskOptions): string {
  const extra = [options.failFirst ? `first ${options.failFirst} call(s) per message time out` : "", options.lazy !== undefined ? `model answers only its first ${options.lazy} item(s)` : ""].filter(Boolean);
  const base =
    options.mode === "hub"
      ? "hub ledger extractor (askLedger.ts extractAsks: regex only, at most 6 per message; feeds the Chief's 'You asked' list)"
      : options.mode === "rules"
      ? "rules only (no model call: what the app keeps when no engine can answer)"
      : options.mode === "oracle"
        ? "oracle (a model that returns exactly the labelled asks: the ceiling the pipeline allows)"
        : options.mode === "recorded"
          ? `recorded replies (${options.recording?.provenance.slice(0, 60) ?? "?"}...)`
          : `live command: ${options.liveCmd}`;
  return extra.length ? `${base}; ${extra.join("; ")}` : base;
}

export function report(run: { results: MessageResult[]; totals: Totals }, options: AskOptions): string {
  const t = run.totals;
  const lines: string[] = [];
  lines.push(`### ${describeMode(options)}`, "");
  lines.push(
    `Recall: **${pct(t.recallStrict)}** of ${t.expected} asks are a row of their own (${t.separate}); ${t.merged} only inside a row that also holds another ask; ${t.maybeOnly} only as a "maybe" line (with those: ${pct(t.recallWithMaybes)}); ${t.missed} missed.`,
    `Implicit asks as their own row: ${t.implicit.separate}/${t.implicit.expected}. Buried asks: ${t.buried.separate}/${t.buried.expected}. Kind agrees with the label: ${t.kindAgrees}/${t.kindChecked}.`,
    `Noise: ${t.cancelledStillOpen}/${t.cancelledTotal} withdrawn asks still open; ${t.duplicateRows} duplicate rows; ${t.notAskRows} pasted sentences kept as asks; ${t.extraRows} other rows with no labelled ask behind them; ${t.extraMaybes} unlabelled "maybe" lines.`,
    ...(options.mode === "rules" || options.mode === "hub"
      ? []
      : [`Model: failed on every try for ${t.modelFailedBoth} of ${t.messages} messages (the rules' reading stands there).`]),
    "",
  );
  lines.push("| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of run.results) {
    const count = (found: AskResult["found"]) => result.asks.filter((ask) => ask.found === found).length;
    const tries = result.trace.attempts.length ? result.trace.attempts.map((attempt) => attempt.outcome).join(" > ") : "none";
    lines.push(
      `| ${result.id} | ${result.expected} | ${count("separate")} | ${count("merged")} | ${count("maybe")} | ${count("missed")} | ${result.rows} | ${result.cancelledStillOpen.length} | ${tries} |`,
    );
  }
  const missed = run.results.flatMap((result) => result.asks.filter((ask) => ask.found === "missed" || ask.found === "merged" || ask.found === "maybe").map((ask) => ({ result, ask })));
  lines.push("", missed.length ? "Not an own row:" : "Every ask is an own row.");
  for (const { result, ask } of missed) lines.push(`- ${result.id} ${ask.id} (${ask.found}${ask.implicit ? ", implicit" : ""}${ask.buried ? ", buried" : ""}): ${ask.anchor}`);
  const noise = run.results.flatMap((result) => [
    ...result.cancelledStillOpen.map((item) => `${result.id} withdrawn but open: ${item.anchor}`),
    ...result.notAskRows.map((item) => `${result.id} pasted sentence kept as ${item.as}: ${item.anchor}`),
    ...(result.duplicateRows ? [`${result.id} ${result.duplicateRows} duplicate row(s)`] : []),
    ...result.extraRows.map((quote) => `${result.id} unlabelled row: ${quote.slice(0, 90)}`),
  ]);
  if (noise.length) lines.push("", "Noise:", ...noise.map((item) => `- ${item}`));
  return lines.join("\n");
}
