import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { noteFromInvoke, tauriDictationPort } from "./dictationPort";
import {
  DICTATION_BUSY,
  DICTATION_DENIED,
  DICTATION_EXPLAIN,
  DICTATION_LISTENING,
  DICTATION_WAITING,
  DICTATION_NOT_HERE,
  DICTATION_NOT_ON_DEVICE,
  DICTATION_NO_MICROPHONE,
  DICTATION_NOTES,
  DICTATION_STOPPED,
  createDictationController,
  dictationExplained,
  idleDictation,
  markDictationExplained,
  noteForEngineMessage,
  placeUtterance,
  reduceDictation,
  type DictationChunk,
  type DictationPort,
  type DictationStorage,
  type DictationView,
  type Selection,
} from "./dictation";

const DASH = /[–—]/;

function memory(): DictationStorage & { dump: Record<string, string> } {
  const dump: Record<string, string> = {};
  return {
    dump,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(dump, key) ? dump[key] : null),
    setItem: (key, value) => {
      dump[key] = value;
    },
  };
}

function scripted(options?: { grant?: boolean; startError?: string }) {
  let grant = options?.grant !== false;
  const startError = options?.startError;
  let onChunk: ((chunk: DictationChunk) => void) | null = null;
  let next = 1;
  const starts: number[] = [];
  const stops: number[] = [];
  let startGate: (() => void) | null = null;
  const port: DictationPort = {
    support: async () => ({ available: true, reason: "" }),
    start: () => {
      const id = next++;
      starts.push(id);
      return new Promise((resolve, reject) => {
        const go = () => {
          if (!grant) reject(new Error(DICTATION_DENIED));
          else if (startError) reject(new Error(startError));
          else resolve(id);
        };
        if (startGate) startGate = go;
        else go();
      });
    },
    stop: async (session) => {
      stops.push(session);
    },
    subscribe(fn) {
      onChunk = fn;
      return () => {
        if (onChunk === fn) onChunk = null;
      };
    },
  };
  return {
    port,
    starts,
    stops,
    /** Hold start() until release(), so a cancel can land while it is in flight. */
    holdStart() {
      startGate = () => {};
    },
    release() {
      const go = startGate;
      startGate = null;
      go?.();
    },
    emit(chunk: Partial<DictationChunk> & { session: number; text: string }) {
      onChunk?.({
        session: chunk.session,
        text: chunk.text,
        finished: chunk.finished === true,
        error: chunk.error === true,
      });
    },
    setGrant(value: boolean) {
      grant = value;
    },
  };
}

function harness(storage: DictationStorage | null = memory(), grant = true) {
  const writes: { text: string; cursor: number }[] = [];
  let text = "";
  let selection: Selection = { start: 0, end: 0 };
  const sends: string[] = [];
  const engine = scripted({ grant });
  const views: DictationView[] = [];
  const controller = createDictationController({
    port: engine.port,
    getText: () => text,
    getSelection: () => selection,
    write: (next, cursor) => {
      writes.push({ text: next, cursor });
      text = next;
      selection = { start: cursor, end: cursor };
    },
    storage,
    onChange: (view) => views.push(view),
  });
  return {
    controller,
    engine,
    writes,
    sends,
    views,
    setText(next: string, caret = next.length) {
      text = next;
      selection = { start: caret, end: caret };
    },
    select(start: number, end: number) {
      selection = { start, end };
    },
    send() {
      sends.push(text);
    },
  };
}

it("places words at the caret, with one space beside neighbours, and leaves an empty utterance alone", () => {
  expect(placeUtterance("", { start: 0, end: 0 }, "buy milk")).toEqual({
    text: "buy milk",
    span: { start: 0, end: 8 },
    cursor: 8,
  });
  expect(placeUtterance("hello", { start: 5, end: 5 }, "there")).toEqual({
    text: "hello there",
    span: { start: 6, end: 11 },
    cursor: 11,
  });
  expect(placeUtterance("hello ", { start: 6, end: 6 }, "there")).toMatchObject({ text: "hello there" });
  expect(placeUtterance("hello world", { start: 5, end: 5 }, "there")).toEqual({
    text: "hello there world",
    span: { start: 6, end: 11 },
    cursor: 11,
  });
  expect(placeUtterance("say world", { start: 4, end: 9 }, "hello")).toMatchObject({
    text: "say hello",
    span: { start: 4, end: 9 },
  });
  expect(placeUtterance("keep world", { start: 5, end: 10 }, "  ")).toEqual({
    text: "keep world",
    span: null,
    cursor: 10,
  });
  expect(placeUtterance("héllo", { start: 5, end: 5 }, "café")).toMatchObject({ text: "héllo café" });
  expect(placeUtterance("a\r\nb", { start: 4, end: 4 }, "c")).toMatchObject({ text: "a\r\nb c" });
  expect(placeUtterance("ab", { start: 5, end: -1 }, "z").text.endsWith("z")).toBe(true);
  expect(placeUtterance("ab", null, "z").text).toBe("ab z");
});

it("asks in plain words before the engine starts, and Not now starts nothing", () => {
  const box = harness(memory(), true);
  box.controller.ask();
  expect(box.controller.view.phase).toBe("explain");
  expect(box.controller.view.note).toBeNull();
  expect(DICTATION_EXPLAIN).not.toMatch(DASH);
  expect(box.engine.starts).toEqual([]);
  box.controller.decline();
  expect(box.controller.view.phase).toBe("idle");
  expect(box.engine.starts).toEqual([]);
  expect(box.sends).toEqual([]);
});

it("remembers a real yes, and treats any other stored value as not yet asked", () => {
  const store = memory();
  expect(dictationExplained(store)).toBe(false);
  expect(dictationExplained(null)).toBe(false);
  store.setItem("monocode.dictationExplained", "true");
  expect(dictationExplained(store)).toBe(false);
  store.setItem("monocode.dictationExplained", "yes");
  expect(dictationExplained(store)).toBe(false);
  markDictationExplained(store);
  expect(dictationExplained(store)).toBe(true);
  expect(() => dictationExplained({
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  })).not.toThrow();
  expect(markDictationExplained({
    getItem: () => null,
    setItem() {
      throw new Error("full");
    },
  })).toBeUndefined();
});

it("writes a partial into the draft, replaces it as the words grow, and does not send", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.setText("hello");
  box.controller.ask();
  await Promise.resolve();
  expect(box.controller.view.phase).toBe("listening");
  expect(box.engine.starts).toEqual([1]);
  box.engine.emit({ session: 1, text: "buy" });
  expect(box.controller.view.text).toBe("hello buy");
  expect(box.controller.view.provisional).toEqual({ start: 6, end: 9 });
  expect(box.controller.view.send).toBe(false);
  box.engine.emit({ session: 1, text: "buy milk" });
  expect(box.controller.view.text).toBe("hello buy milk");
  expect(box.writes.map((write) => write.text)).toEqual(["hello buy", "hello buy milk"]);
  box.engine.emit({ session: 1, text: "buy milk" });
  expect(box.writes).toHaveLength(2);
  expect(box.sends).toEqual([]);
  expect(DICTATION_LISTENING).toBe("Still listening");
});

it("unmarks the words when the person stops, keeps them, and still does not send", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "buy milk" });
  box.controller.stop();
  expect(box.controller.view.phase).toBe("settling");
  expect(box.controller.view.provisional).toBeNull();
  expect(box.controller.view.text).toBe("buy milk");
  expect(box.controller.view.send).toBe(false);
  box.engine.emit({ session: 1, text: "Buy milk.", finished: true });
  expect(box.controller.view.text).toBe("Buy milk.");
  expect(box.controller.view.phase).toBe("idle");
  expect(box.controller.view.provisional).toBeNull();
  box.engine.emit({ session: 1, text: "Buy milk please." });
  expect(box.controller.view.text).toBe("Buy milk.");
  expect(box.sends).toEqual([]);
  expect(box.engine.stops).toContain(1);
});

it("ignores a late or foreign chunk, a chunk after seal, and an empty one", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.setText("keep");
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "" });
  expect(box.controller.view.text).toBe("keep");
  expect(box.writes).toEqual([]);
  box.engine.emit({ session: 2, text: "other" });
  box.engine.emit({ session: 1, text: "yes" });
  box.controller.seal();
  box.engine.emit({ session: 1, text: "yes more", finished: true });
  expect(box.controller.view.text).toBe("keep yes");
  expect(box.controller.view.provisional).toBeNull();
  expect(box.sends).toEqual([]);
});

it("drops the engine when the person types, and does not write over their text", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "buy" });
  box.setText("buy please");
  box.controller.onTyped("buy please");
  expect(box.controller.view.phase).toBe("idle");
  expect(box.controller.view.text).toBe("buy please");
  box.engine.emit({ session: 1, text: "buy milk", finished: true });
  expect(box.controller.view.text).toBe("buy please");
  expect(box.writes.map((write) => write.text)).toEqual(["buy"]);
  expect(box.engine.stops).toContain(1);
});

it("does not start when permission is refused, and does not show a raw engine error", async () => {
  const store = memory();
  markDictationExplained(store);
  const denied = harness(store, false);
  denied.controller.ask();
  await Promise.resolve();
  await Promise.resolve();
  expect(denied.controller.view.phase).toBe("idle");
  expect(denied.controller.view.note).toBe(DICTATION_DENIED);
  expect(denied.writes).toEqual([]);
  expect(denied.sends).toEqual([]);

  const leaked = `NSError domain=Speech path=/Users/secret ${"x".repeat(8)}`;
  expect(noteForEngineMessage(leaked)).toBe(DICTATION_STOPPED);
  expect(noteForEngineMessage(leaked)).not.toContain("/Users");
  expect(noteForEngineMessage(`dictation_start: ${DICTATION_DENIED}`)).toBe(DICTATION_DENIED);
  expect(noteForEngineMessage(DICTATION_NOT_ON_DEVICE)).toBe(DICTATION_NOT_ON_DEVICE);
  expect(noteForEngineMessage(DICTATION_NO_MICROPHONE)).toBe(DICTATION_NO_MICROPHONE);
  expect(noteForEngineMessage(DICTATION_BUSY)).toBe(DICTATION_BUSY);
  for (const note of [...DICTATION_NOTES, DICTATION_EXPLAIN, DICTATION_LISTENING, DICTATION_WAITING, DICTATION_NOT_HERE]) {
    expect(note).not.toMatch(DASH);
  }
});

it("stops an in-flight start when the draft is sealed, and ignores the session that comes back", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.engine.holdStart();
  box.setText("stay");
  box.controller.ask();
  expect(box.controller.view.phase).toBe("authorizing");
  box.controller.seal();
  box.engine.release();
  await Promise.resolve();
  await Promise.resolve();
  expect(box.controller.view.phase).toBe("idle");
  expect(box.controller.view.text).toBe("");
  expect(box.writes).toEqual([]);
  expect(box.engine.stops).toContain(1);
  box.engine.emit({ session: 1, text: "late" });
  expect(box.writes).toEqual([]);
  expect(box.sends).toEqual([]);
});

it("keeps heard words when the engine stops on a problem", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "half" });
  box.engine.emit({ session: 1, text: "", error: true, finished: true });
  expect(box.controller.view.text).toBe("half");
  expect(box.controller.view.phase).toBe("idle");
  expect(box.controller.view.note).toBe(DICTATION_STOPPED);
  expect(box.controller.view.send).toBe(false);
});

it("does not restart over a draft that is already listening", async () => {
  const store = memory();
  markDictationExplained(store);
  const box = harness(store);
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "once" });
  box.controller.ask();
  expect(box.controller.view.text).toBe("once");
  expect(box.engine.starts).toEqual([1]);
});

it("reduces a finished chunk straight to idle text and never flips send", () => {
  let view = reduceDictation(idleDictation("hi"), { type: "continue" });
  view = reduceDictation(view, {
    type: "authorized",
    session: 4,
    base: "hi",
    selection: { start: 2, end: 2 },
  });
  view = reduceDictation(view, { type: "chunk", session: 4, text: "there", finished: true, error: false });
  expect(view).toMatchObject({ phase: "idle", text: "hi there", provisional: null, send: false });
  view = reduceDictation(view, { type: "chunk", session: 4, text: "nope", finished: false, error: false });
  expect(view.text).toBe("hi there");
  const idle = idleDictation("");
  expect(reduceDictation(idle, { type: "authorized", session: 1, base: "x", selection: { start: 0, end: 0 } })).toBe(idle);
  expect(reduceDictation(idle, { type: "stop" })).toBe(idle);
  expect(reduceDictation(idle, { type: "seal" })).toBe(idle);
});

it("the dictation module has no send path", () => {
  const src = readFileSync(new URL("./dictation.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/onSend|\bsubmit\s*\(/);
});

it("keeps a known refusal and hides a raw engine path", () => {
  expect(noteFromInvoke(DICTATION_DENIED)).toBe(DICTATION_DENIED);
  expect(noteFromInvoke(`dictation_start: ${DICTATION_NOT_HERE}`)).toBe(DICTATION_NOT_HERE);
  const leaked = noteFromInvoke("NSError domain=Speech path=/Users/secret");
  expect(leaked).toBe(DICTATION_STOPPED);
  expect(leaked).not.toContain("/Users");
});

it("stays off outside the desktop app and does not upload audio", async () => {
  const support = await tauriDictationPort.support();
  expect(support).toEqual({ available: false, reason: DICTATION_NOT_HERE });
  await expect(tauriDictationPort.start()).rejects.toThrow(DICTATION_NOT_HERE);
  const src = readFileSync(new URL("./dictationPort.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|FormData/);
});

it("the reducer ignores a chunk from another session, even if the controller were to pass it on", () => {
  let view = reduceDictation(idleDictation("hi"), { type: "continue" });
  view = reduceDictation(view, {
    type: "authorized",
    session: 4,
    base: "hi",
    selection: { start: 2, end: 2 },
  });
  const before = view;
  view = reduceDictation(view, { type: "chunk", session: 9, text: "stray", finished: false, error: false });
  expect(view.text).toBe(before.text);
  expect(view.provisional).toBeNull();
  expect(view.session).toBe(4);
});

// Review fixes (PR #196, HIGH 1, MEDIUM 3, LOW 4).

it("keeps no chunks while idle, and while the engine is starting only the latest one", async () => {
  const box = harness(memory());
  box.engine.emit({ session: 1, text: "said before any start" });
  expect(box.controller.pending).toBe(0);
  box.engine.holdStart();
  box.controller.ask();
  box.controller.accept();
  for (let i = 0; i < 500; i += 1) box.engine.emit({ session: 1, text: `word ${i}` });
  expect(box.controller.pending).toBeLessThanOrEqual(1);
  box.engine.release();
  await Promise.resolve();
  await Promise.resolve();
  expect(box.controller.view.text).toBe("word 499");
  expect(box.writes.length).toBeLessThanOrEqual(2);
});

it("text added elsewhere while listening is kept, and the next partial does not overwrite it", async () => {
  const box = harness(markedStore());
  box.controller.ask();
  await Promise.resolve();
  box.engine.emit({ session: 1, text: "buy milk" });
  expect(box.controller.view.text).toBe("buy milk");
  // Add to chat, Ask Alfred or an MCP tag writes into the draft from outside dictation.
  box.setText("buy milk. Also check the invoice");
  box.engine.emit({ session: 1, text: "buy oat milk" });
  expect(box.controller.view.text).toBe("buy milk. Also check the invoice");
  expect(box.controller.view.phase).toBe("idle");
  expect(box.engine.stops).toEqual([1]);
});

it("cancel while the permission prompt is up stops the start that comes back", async () => {
  const box = harness(memory());
  box.engine.holdStart();
  box.controller.ask();
  box.controller.accept();
  expect(box.controller.view.phase).toBe("authorizing");
  box.controller.cancel();
  expect(box.controller.view.phase).toBe("idle");
  box.engine.release();
  await Promise.resolve();
  await Promise.resolve();
  expect(box.engine.stops).toEqual([1]);
  expect(box.controller.view.phase).toBe("idle");
  expect(box.controller.view.session).toBeNull();
});

it("dictated words lose hidden characters and are capped in size", () => {
  expect(placeUtterance("", null, "buy​ milk").text).toBe("buy milk");
  const long = placeUtterance("", null, "word ".repeat(10_000));
  expect(long.text.length).toBeLessThanOrEqual(4000);
});

it("unmounting the composer stops a live session", async () => {
  const box = harness(markedStore());
  box.controller.ask();
  await Promise.resolve();
  expect(box.controller.view.phase).toBe("listening");
  box.controller.dispose();
  expect(box.engine.stops).toEqual([1]);
});

function markedStore(): DictationStorage {
  const store = memory();
  markDictationExplained(store);
  return store;
}
