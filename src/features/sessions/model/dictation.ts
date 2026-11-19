// WP-131: desktop dictation writes into the draft and never sends. The recogniser
// is a port (the Mac's on-device speech API, or a stub in tests). Audio is not
// part of this model.

import { stripHiddenCharacters } from "./hiddenText";

export type Selection = { start: number; end: number };

export type DictationRange = { start: number; end: number };

export type DictationPhase =
  | "idle"
  | "explain"
  | "authorizing"
  | "listening"
  | "settling";

export type DictationAnchor = {
  base: string;
  selection: Selection;
};

/** What the draft looks like. `send` is always false: dictation cannot send. */
export type DictationView = {
  phase: DictationPhase;
  text: string;
  cursor: number;
  provisional: DictationRange | null;
  session: number | null;
  anchor: DictationAnchor | null;
  note: string | null;
  send: false;
};

export const DICTATION_EXPLAIN =
  "Dictation uses this Mac's microphone and writes the words into your draft. The audio stays on this Mac. Nothing is sent until you press Send.";

export const DICTATION_LISTENING = "Still listening";

export const DICTATION_WAITING = "Waiting for permission";

export const DICTATION_DENIED =
  "Dictation needs the microphone and speech recognition. Turn them on in System Settings, then try again.";

export const DICTATION_NOT_ON_DEVICE =
  "This Mac would have to send audio away to transcribe, so dictation stays off.";

export const DICTATION_NO_MICROPHONE =
  "No microphone is available, so dictation did not start.";

export const DICTATION_BUSY = "Dictation is already on.";

export const DICTATION_NOT_HERE = "Dictation is off in this version of the app.";

export const DICTATION_STOPPED =
  "Dictation stopped. What was heard so far stays in the draft.";

export const DICTATION_NOTES = [
  DICTATION_NOT_HERE,
  DICTATION_DENIED,
  DICTATION_NOT_ON_DEVICE,
  DICTATION_NO_MICROPHONE,
  DICTATION_BUSY,
  DICTATION_STOPPED,
] as const;

const EXPLAINED_KEY = "monocode.dictationExplained";

export type DictationStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Only the exact value written by this app counts. Anything else asks again. */
export function dictationExplained(storage: DictationStorage | null): boolean {
  try {
    return storage?.getItem(EXPLAINED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markDictationExplained(storage: DictationStorage | null): void {
  try {
    storage?.setItem(EXPLAINED_KEY, "1");
  } catch {
    // Private mode or a full store: the next click asks again.
  }
}

/** A message from the engine is shown only when it is one of ours. */
export function noteForEngineMessage(message: string): string {
  const text = message.trim();
  for (const known of DICTATION_NOTES) {
    if (text === known || text.endsWith(known)) return known;
  }
  return DICTATION_STOPPED;
}

export function idleDictation(text = ""): DictationView {
  return {
    phase: "idle",
    text,
    cursor: text.length,
    provisional: null,
    session: null,
    anchor: null,
    note: null,
    send: false,
  };
}

function clampIndex(text: string, index: unknown): number {
  if (typeof index !== "number" || !Number.isFinite(index)) return text.length;
  return Math.max(0, Math.min(text.length, Math.trunc(index)));
}

export function clampSelection(text: string, selection: Partial<Selection> | null | undefined): Selection {
  const start = clampIndex(text, selection?.start);
  const end = clampIndex(text, selection?.end);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** The most one utterance may add to the draft. Speech at a normal pace never comes near it. */
export const MAX_UTTERANCE_CHARS = 4000;

/**
 * The recogniser's words, placed at the selection. An empty utterance leaves
 * the draft alone (it does not delete the selection). Neighbours get a single
 * space. The span covers the words only, so the draft can mark them. Hidden
 * characters are removed, and the words are cut to MAX_UTTERANCE_CHARS (well
 * under the large-paste limit, so dictation never becomes an attachment).
 */
export function placeUtterance(
  base: string,
  selection: Partial<Selection> | null | undefined,
  utterance: unknown,
): { text: string; span: DictationRange | null; cursor: number } {
  const spoken = typeof utterance === "string" ? stripHiddenCharacters(utterance).text : "";
  const words = Array.from(spoken).slice(0, MAX_UTTERANCE_CHARS).join("").trim();
  const { start, end } = clampSelection(base, selection);
  if (!words) return { text: base, span: null, cursor: end };
  const before = base.slice(0, start);
  const after = base.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const spanStart = before.length + lead.length;
  return {
    text: before + lead + words + trail + after,
    span: { start: spanStart, end: spanStart + words.length },
    cursor: spanStart + words.length + trail.length,
  };
}

export type DictationChunk = {
  session: number;
  text: string;
  finished: boolean;
  error: boolean;
};

export type DictationEvent =
  | { type: "ask" }
  | { type: "decline" }
  | { type: "continue" }
  | { type: "authorized"; session: number; base: string; selection: Selection }
  | { type: "denied"; message?: string }
  | ({ type: "chunk" } & DictationChunk)
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "seal" }
  | { type: "typed"; text: string };

function kept(state: DictationView): DictationView {
  return state.send ? { ...state, send: false } : state;
}

export function reduceDictation(state: DictationView, event: DictationEvent): DictationView {
  switch (event.type) {
    case "ask":
      if (state.phase !== "idle") return kept(state);
      return { ...state, phase: "explain", note: null, send: false };
    case "decline":
      if (state.phase !== "explain") return kept(state);
      return { ...state, phase: "idle", send: false };
    case "continue":
      if (state.phase !== "explain" && state.phase !== "idle") return kept(state);
      return { ...state, phase: "authorizing", note: null, send: false };
    case "authorized": {
      if (state.phase !== "authorizing") return kept(state);
      if (typeof event.session !== "number" || !Number.isFinite(event.session) || event.session <= 0) {
        return kept(state);
      }
      const base = typeof event.base === "string" ? event.base : state.text;
      const selection = clampSelection(base, event.selection);
      return {
        ...state,
        phase: "listening",
        session: event.session,
        anchor: { base, selection },
        text: base,
        cursor: selection.end,
        provisional: null,
        note: null,
        send: false,
      };
    }
    case "denied":
      if (state.phase !== "authorizing" && state.phase !== "listening") return kept(state);
      return {
        ...idleDictation(state.text),
        note: noteForEngineMessage(event.message ?? DICTATION_DENIED),
      };
    case "chunk":
      return applyChunk(state, event);
    case "stop":
      if (state.phase !== "listening") return kept(state);
      return { ...state, phase: "settling", provisional: null, send: false };
    case "cancel":
      if (state.phase !== "listening" && state.phase !== "settling" && state.phase !== "authorizing") {
        return kept(state);
      }
      return idleDictation(state.anchor?.base ?? state.text);
    case "seal":
      if (state.phase === "idle" && state.session == null) return kept(state);
      return {
        ...state,
        phase: "idle",
        provisional: null,
        session: null,
        anchor: null,
        send: false,
      };
    case "typed":
      return applyTyped(state, event.text);
    default:
      return kept(state);
  }
}

function applyChunk(state: DictationView, event: DictationChunk): DictationView {
  if (state.session == null || event.session !== state.session) return kept(state);
  if (state.phase !== "listening" && state.phase !== "settling") return kept(state);
  if (!state.anchor) return kept(state);
  if (typeof event.text !== "string") return kept(state);

  const heard = event.error ? event.text.trim() : event.text;
  const placed = heard.trim()
    ? placeUtterance(state.anchor.base, state.anchor.selection, heard)
    : null;
  const text = placed ? placed.text : state.text;
  const cursor = placed ? placed.cursor : state.cursor;

  if (event.error) {
    return {
      ...idleDictation(text),
      cursor,
      note: DICTATION_STOPPED,
    };
  }
  if (event.finished) {
    return { ...idleDictation(text), cursor, note: null };
  }
  if (state.phase === "settling") {
    return { ...state, text, cursor, provisional: null, send: false };
  }
  return { ...state, text, cursor, provisional: placed?.span ?? null, send: false };
}

function applyTyped(state: DictationView, text: unknown): DictationView {
  if (state.phase !== "listening" && state.phase !== "settling") return kept(state);
  if (typeof text !== "string" || text === state.text) return kept(state);
  // The person edited the draft. Their text wins, and the engine is dropped.
  return idleDictation(text);
}

export type DictationSupport = { available: boolean; reason: string };

export interface DictationPort {
  support(): Promise<DictationSupport>;
  /** Resolves with a session id, or throws one of the known notes. */
  start(): Promise<number>;
  stop(session: number): Promise<void>;
  subscribe(onChunk: (chunk: DictationChunk) => void): () => void;
  /**
   * The Hub's start token, known before the microphone is ready.
   * Absent when the port cannot tell the controller that early.
   */
  watchStart?(onToken: (token: number) => void): () => void;
}

export type DictationController = {
  readonly view: DictationView;
  ask(): void;
  accept(): void;
  decline(): void;
  stop(): void;
  seal(): void;
  onTyped(text: string): void;
  cancel(): void;
  /** Chunks held for a later publish. Idle keeps none; a start in flight keeps only the latest. */
  readonly pending: number;
  dispose(): void;
};

/**
 * Owns one dictation attempt. Late chunks for an old session are ignored.
 * Stopping the engine is idempotent. This object never sends the draft.
 */
export function createDictationController(deps: {
  port: DictationPort;
  getText: () => string;
  getSelection: () => Selection;
  write: (text: string, cursor: number) => void;
  storage: DictationStorage | null;
  onChange?: (view: DictationView) => void;
}): DictationController {
  let view = idleDictation("");
  let generation = 0;
  let arming = false;
  const buffer: DictationChunk[] = [];
  let disposed = false;
  /** The Hub's id for the start that is in flight, known before the microphone is ready. */
  let startToken: number | null = null;
  /** The generation whose start is still in flight. A token for any other generation is stopped. */
  let inflight = 0;
  /** The draft as the controller last left it. Text that differs from this was written from outside dictation. */
  const draftChanged = () => deps.getText() !== view.text;

  const publish = (event: DictationEvent) => {
    if (disposed && event.type !== "seal") return;
    const prev = view;
    const next = reduceDictation(prev, event);
    view = next;
    deps.onChange?.(next);
    // Authorized copies the draft that is already on screen. Writing it again
    // would move the caret. A typed edit is already in the field.
    if (next.text !== prev.text && event.type !== "typed" && event.type !== "authorized") {
      deps.write(next.text, next.cursor);
    }
    if (prev.session != null && next.session == null) {
      void deps.port.stop(prev.session).catch(() => {});
    }
  };

  const unwatch =
    deps.port.watchStart?.((token) => {
      if (typeof token !== "number" || !Number.isFinite(token) || token <= 0) return;
      const pending =
        inflight === generation &&
        (view.phase === "authorizing" || view.phase === "listening" || view.phase === "settling");
      if (pending) {
        startToken = token;
        return;
      }
      void deps.port.stop(token).catch(() => {});
    }) ?? (() => {});

  const unsubscribe = deps.port.subscribe((chunk) => {
    if (disposed) return;
    if (!chunk || typeof chunk.session !== "number" || typeof chunk.text !== "string") return;
    const safe: DictationChunk = {
      session: chunk.session,
      text: chunk.text,
      finished: chunk.finished === true,
      error: chunk.error === true,
    };
    if (arming) {
      // The engine can speak before its start answers. Only the latest words matter, so keep just those.
      buffer.length = 0;
      buffer.push(safe);
      return;
    }
    if (view.session == null) return;
    if ((view.phase === "listening" || view.phase === "settling") && draftChanged()) {
      // Add to chat, Ask Alfred, an MCP tag or an undo wrote into the draft. Their text wins, as typing does.
      publish({ type: "typed", text: deps.getText() });
      return;
    }
    if (safe.session === view.session) publish({ type: "chunk", ...safe });
  });

  const begin = () => {
    const attempt = ++generation;
    inflight = attempt;
    startToken = null;
    arming = true;
    buffer.length = 0;
    publish({ type: "continue" });
    void deps.port.start().then(
      (session) => {
        if (disposed || attempt !== generation || view.phase !== "authorizing") {
          arming = false;
          if (typeof session === "number") void deps.port.stop(session).catch(() => {});
          return;
        }
        const base = deps.getText();
        const selection = deps.getSelection();
        publish({ type: "authorized", session, base, selection });
        const pending = buffer.splice(0);
        arming = false;
        for (const chunk of pending) {
          if (chunk.session === session && view.session === session) publish({ type: "chunk", ...chunk });
        }
      },
      (error: unknown) => {
        arming = false;
        buffer.length = 0;
        if (disposed || attempt !== generation) return;
        const message = error instanceof Error ? error.message : "";
        publish({ type: "denied", message });
      },
    );
  };

  return {
    get view() {
      return view;
    },
    ask() {
      if (disposed || view.phase !== "idle") return;
      if (dictationExplained(deps.storage)) begin();
      else publish({ type: "ask" });
    },
    accept() {
      if (disposed || view.phase !== "explain") return;
      markDictationExplained(deps.storage);
      begin();
    },
    decline() {
      publish({ type: "decline" });
    },
    stop() {
      if (view.phase !== "listening") return;
      const session = view.session;
      publish({ type: "stop" });
      if (session != null) void deps.port.stop(session).catch(() => {});
    },
    seal() {
      if (view.phase === "idle" && view.session == null && !arming) return;
      const token = view.session == null ? startToken : null;
      startToken = null;
      generation += 1;
      arming = false;
      buffer.length = 0;
      publish({ type: "seal" });
      if (token != null) void deps.port.stop(token).catch(() => {});
    },
    onTyped(text: string) {
      publish({ type: "typed", text });
    },
    cancel() {
      if (disposed || view.phase !== "authorizing") return;
      // The token is known before the prompt ends, so the stop reaches the helper while it is still asking.
      // A start that answers later is stopped again, because its attempt is no longer current.
      const token = startToken;
      startToken = null;
      generation += 1;
      arming = false;
      buffer.length = 0;
      publish({ type: "cancel" });
      if (token != null) void deps.port.stop(token).catch(() => {});
    },
    get pending() {
      return buffer.length;
    },
    dispose() {
      disposed = true;
      generation += 1;
      arming = false;
      const session = view.session;
      const token = session == null ? startToken : null;
      startToken = null;
      view = { ...view, phase: "idle", session: null, provisional: null };
      unsubscribe();
      unwatch();
      if (session != null) void deps.port.stop(session).catch(() => {});
      else if (token != null) void deps.port.stop(token).catch(() => {});
    },
  };
}
