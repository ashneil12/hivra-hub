// @vitest-environment happy-dom
// Checks for the extraction eval (formal/asks/eval, part A of formal/asks/README.md). The eval itself is a measurement
// and is not wired into CI; this file only keeps the eval honest:
//  - the corpus is well formed (every anchor is in its message word for word, 3 to 8 labelled asks, "Example:" first);
//  - the recorded replies are well formed;
//  - the oracle run (a model that returns exactly the labelled asks) loses none: if it does, the pipeline loses asks;
//  - hearLikeApp, the eval's copy of the effect inside useAskLedger, gives the same ledger as the REAL hook rendered
//    on the same message with the same model call, so the eval cannot drift from the app unnoticed.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import corpusJson from "../../../../formal/asks/eval/messages.json";
import recordedJson from "../../../../formal/asks/eval/recorded/typical.json";
import {
  askFor,
  evaluate,
  hearLikeApp,
  MODEL_TRIES,
  type AskOptions,
  type Corpus,
  type EvalMessage,
  type Recording,
} from "../../../../formal/asks/eval/lib";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { Session } from "../../sessions/model/session";
import { useAskLedger } from "../hooks/useAskLedger";
import hookSource from "../hooks/useAskLedger.ts?raw";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { quoteIn, type Ask } from "../model/asks";

const corpus = corpusJson as unknown as Corpus;
const recording = recordedJson as unknown as Recording;

describe("the eval corpus", () => {
  it("is ten messages, each starting with Example: and holding 3 to 8 labelled asks", () => {
    expect(corpus.messages).toHaveLength(10);
    expect(new Set(corpus.messages.map((message) => message.id)).size).toBe(10);
    for (const message of corpus.messages) {
      expect(message.text.startsWith("Example:"), message.id).toBe(true);
      expect(message.asks.length, message.id).toBeGreaterThanOrEqual(3);
      expect(message.asks.length, message.id).toBeLessThanOrEqual(8);
      expect(new Set(message.asks.map((ask) => ask.id)).size, message.id).toBe(message.asks.length);
    }
  });

  it("has every anchor in its message word for word, and the shapes the brief asks for", () => {
    let cancelled = 0;
    let duplicated = 0;
    let implicit = 0;
    let buried = 0;
    for (const message of corpus.messages) {
      for (const ask of message.asks) {
        expect(quoteIn(ask.anchor, message.text), `${message.id} ${ask.id}`).toBe(true);
        if (ask.cancelled) {
          cancelled += 1;
          expect(ask.withdrawnBy, `${message.id} ${ask.id} needs withdrawnBy`).toBeTruthy();
          expect(quoteIn(ask.withdrawnBy ?? "", message.text), `${message.id} ${ask.id} withdrawnBy`).toBe(true);
        }
        if (ask.implicit) implicit += 1;
        if (ask.buried) buried += 1;
      }
      for (const dup of message.duplicates ?? []) {
        duplicated += 1;
        expect(quoteIn(dup.anchor, message.text), `${message.id} duplicate`).toBe(true);
        expect(message.asks.some((ask) => ask.id === dup.of), `${message.id} duplicate of`).toBe(true);
      }
      for (const item of message.notAsks ?? []) expect(quoteIn(item.anchor, message.text), `${message.id} notAsk`).toBe(true);
    }
    expect(cancelled).toBeGreaterThanOrEqual(2);
    expect(duplicated).toBeGreaterThanOrEqual(2);
    expect(implicit).toBeGreaterThanOrEqual(3);
    expect(buried).toBeGreaterThanOrEqual(3);
  });

  it("has a recorded reply for every message, each quote copied from it word for word", () => {
    expect(recording.provenance).toMatch(/^SIMULATED/);
    for (const message of corpus.messages) {
      const answer = recording.answers[message.id];
      expect(answer, message.id).toBeTruthy();
      for (const item of (answer.items ?? []) as Array<{ quote: string; kind: string }>) {
        expect(quoteIn(item.quote, message.text), `${message.id}: ${item.quote}`).toBe(true);
        expect(["do", "answer", "decide", "rule", "idea"]).toContain(item.kind);
      }
    }
  });
});

describe("the pipeline the eval runs", () => {
  it("loses no labelled ask when the model returns exactly the labelled asks (the oracle ceiling)", async () => {
    const run = await evaluate(corpus, { mode: "oracle" });
    const lost = run.results.flatMap((result) => result.asks.filter((ask) => ask.found !== "separate").map((ask) => `${result.id} ${ask.id}`));
    expect(lost).toEqual([]);
    expect(run.totals.recallStrict).toBe(1);
  });

  it("keeps the labelled withdrawn asks out when the model leaves them out (the oracle drops none it was not given)", async () => {
    const run = await evaluate(corpus, { mode: "oracle" });
    expect(run.totals.cancelledStillOpen).toBe(0);
  });

  it("mirrors MODEL_TRIES from the hook", () => {
    expect(hookSource).toContain(`const MODEL_TRIES = ${MODEL_TRIES};`);
  });
});

// ---- Parity with the real hook ----------------------------------------------------------------------------------------

type Shape = { n: number; id: string; quote: string; summary: string; kind: string; status: string; heardBy: string };
const shape = (asks: readonly Ask[]): Shape[] =>
  asks.map((ask) => ({ n: ask.n, id: ask.id, quote: ask.quote, summary: ask.summary, kind: ask.kind, status: ask.status, heardBy: ask.heardBy }));

async function viaMirror(message: EvalMessage, options: AskOptions) {
  const store = createAskStore(memoryDisk(), () => 1_000);
  await store.load();
  await hearLikeApp(store, {
    text: message.text,
    mateId: "mate",
    sessionId: "chat-1",
    blockId: "blk-1",
    ask: askFor(message, options),
    now: () => 2_000,
  });
  return { asks: shape(store.doc().asks), mark: store.doc().heard["blk-1"] };
}

let mounted: { unmount: () => void; container: HTMLElement } | undefined;

async function viaRealHook(message: EvalMessage, options: AskOptions): Promise<{ asks: Shape[]; mark: unknown }> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store: AskStore = createAskStore(memoryDisk(), () => 1_000);
  setAskStore(store);
  const session = {
    id: "chat-1",
    busy: false,
    queuedMessages: [],
    blocks: [{ id: "blk-1", role: "user", text: message.text, startedAt: 1_800_000_000_000 }],
  } as unknown as Session;
  const ask = askFor(message, options);
  function Probe() {
    useAskLedger({ sessions: [session], enabled: true, mateOf: () => "mate", ...(ask ? { ask } : {}), cli: async () => "app" });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { unmount: () => root.unmount(), container };
  await act(async () => {
    root.render(createElement(Probe));
  });
  // Let the quick reading, the model reading and the retry settle: each ledger write re-runs the hook's effect.
  let still = 0;
  let last = "";
  for (let step = 0; step < 60 && still < 4; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const now = JSON.stringify([store.doc().heard, store.doc().revision]);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return { asks: shape(store.doc().asks), mark: store.doc().heard["blk-1"] };
}

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  setAskStore(undefined);
  vi.unstubAllGlobals();
});

const byId = (id: string): EvalMessage => corpus.messages.find((message) => message.id === id) as EvalMessage;
const markOf = (value: unknown) => {
  const mark = value as { by: string; tries: number } | undefined;
  return mark ? { by: mark.by, tries: mark.tries } : undefined;
};

describe("hearLikeApp is the hook's effect", () => {
  const cases: Array<[string, string, AskOptions]> = [
    ["a model that answers well", "m01-polish-list", { mode: "oracle" }],
    ["a recorded reply with a miss and a repeat", "m02-mobile-build", { mode: "recorded", recording }],
    ["a one-sentence run-on read by the model", "m04-run-on", { mode: "recorded", recording }],
    ["a model that names only its first two asks", "m05-releases", { mode: "recorded", recording, lazy: 2 }],
    ["a first call that times out, then a good one", "m07-pasted-customer", { mode: "recorded", recording, failFirst: 1 }],
    ["both model calls timing out", "m09-call-notes", { mode: "recorded", recording, failFirst: 2 }],
    ["no model at all", "m10-week-notes", { mode: "rules" }],
  ];
  it.each(cases)("%s (%s)", async (_label, id, options) => {
    const message = byId(id);
    const mirror = await viaMirror(message, options);
    const real = await viaRealHook(message, options);
    expect(real.asks).toEqual(mirror.asks);
    expect(markOf(real.mark)).toEqual(markOf(mirror.mark));
  });

  it("a short single ask is not written down at all, by either", async () => {
    const message: EvalMessage = { id: "short", shape: "one short ask", text: "Can you fix the login screen flicker please", asks: [] };
    const mirror = await viaMirror(message, { mode: "rules" });
    const real = await viaRealHook(message, { mode: "rules" });
    expect(mirror.asks).toEqual([]);
    expect(real.asks).toEqual([]);
    expect(markOf(real.mark)).toEqual(markOf(mirror.mark));
  });
});
