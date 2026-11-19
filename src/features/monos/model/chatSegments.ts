// A first mate's chat never ends, but the engine session behind it is swapped when it fills (monoRotation.ts). Each
// swap closes a segment of the chat. The segments are kept in the app's own database (one hub document,
// `chat-segments`), so they survive a cleared webview and every window reads the same ones. A segment holds where the
// swap happened, what the fresh session was handed (shown read-only under the "Chat tidied" line), and the rotation's
// carried lines, so the next swap briefs from where this one stopped.

import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import type { MonoRotation } from "./monoRotation";

export const SEGMENTS_DOC_KEY = "chat-segments";
/** Kept in all. The oldest go first; the chat itself is never touched. */
const SEGMENTS_MAX = 400;
/** What the fresh session was handed, as shown under the marker. */
const GIVEN_MAX = 16_000;
const TRIES = 5;

export type ChatSegment = {
  sessionId: string;
  at: number;
  reason: MonoRotation["reason"];
  /** The last block the replaced session saw. */
  afterBlockId?: string;
  /** Ash's message that opened the fresh session: the "Chat tidied" line sits above it. */
  firstBlockId?: string;
  /** What the fresh session was handed about the conversation. */
  given: string;
  /** The rotation's carried lines (monoRotation.ts `earlier`). */
  earlier: string[];
};

export type SegmentDoc = { revision: number; segments: ChatSegment[] };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function parseSegments(raw: unknown, revision: number): SegmentDoc {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const segments: ChatSegment[] = [];
  for (const item of Array.isArray(value.segments) ? value.segments : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sessionId = text(row.sessionId, 200);
    const at = row.at;
    if (!sessionId || typeof at !== "number" || !Number.isFinite(at)) continue;
    const reason = row.reason === "idle" || row.reason === "restart" ? row.reason : "context";
    segments.push({
      sessionId,
      at,
      reason,
      ...(text(row.afterBlockId, 200) ? { afterBlockId: text(row.afterBlockId, 200) } : {}),
      ...(text(row.firstBlockId, 200) ? { firstBlockId: text(row.firstBlockId, 200) } : {}),
      given: text(row.given, GIVEN_MAX),
      earlier: Array.isArray(row.earlier) ? row.earlier.filter((line): line is string => typeof line === "string").slice(-60) : [],
    });
  }
  return { revision, segments: segments.slice(-SEGMENTS_MAX) };
}

export function withSegment(doc: SegmentDoc, segment: ChatSegment): SegmentDoc {
  const clean: ChatSegment = { ...segment, given: segment.given.slice(0, GIVEN_MAX) };
  return { ...doc, segments: [...doc.segments, clean].slice(-SEGMENTS_MAX) };
}

/** The newest segment of a chat as the rotation record the next swap starts from. */
export function latestRotation(doc: SegmentDoc, sessionId: string): MonoRotation | undefined {
  for (let index = doc.segments.length - 1; index >= 0; index--) {
    const segment = doc.segments[index];
    if (segment.sessionId !== sessionId) continue;
    return { at: segment.at, reason: segment.reason, ...(segment.afterBlockId ? { afterBlockId: segment.afterBlockId } : {}), earlier: segment.earlier };
  }
  return undefined;
}

/** The segment whose fresh session opened on this message, if any. */
export function segmentOpenedBy(doc: SegmentDoc, blockId: string): ChatSegment | undefined {
  return doc.segments.find((segment) => segment.firstBlockId === blockId);
}

export type SegmentStore = {
  load(): Promise<SegmentDoc>;
  doc(): SegmentDoc;
  loaded(): boolean;
  add(segment: ChatSegment): Promise<void>;
  forget(sessionId: string): Promise<void>;
  subscribe(fn: () => void): () => void;
};

export function createSegmentStore(disk: LocalHubDisk): SegmentStore {
  let file: SegmentDoc = { revision: 0, segments: [] };
  let loaded = false;
  let watching = false;
  let first: Promise<SegmentDoc> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const adopt = (next: SegmentDoc) => {
    if (loaded && next.revision < file.revision) return;
    file = next;
    for (const fn of [...listeners]) fn();
  };
  const read = async () => {
    const doc = await disk.readDoc(SEGMENTS_DOC_KEY);
    return parseSegments(doc.value, doc.rev);
  };
  const refresh = async () => {
    adopt(await read());
    loaded = true;
    if (!watching && disk.watch) {
      watching = true;
      disk.watch((key, rev) => {
        if (key === SEGMENTS_DOC_KEY && rev > file.revision) void refresh().catch(() => undefined);
      });
    }
    return file;
  };
  const load = (): Promise<SegmentDoc> => {
    if (loaded) return Promise.resolve(file);
    first ??= refresh().finally(() => {
      first = undefined;
    });
    return first;
  };
  const write = (fn: (base: SegmentDoc) => SegmentDoc): Promise<void> => {
    const run = chain.then(async () => {
      for (let attempt = 0; attempt < TRIES; attempt += 1) {
        let base: SegmentDoc;
        try {
          base = await read();
        } catch {
          continue;
        }
        const next = fn(base);
        if (next === base) return;
        let rev: number | null;
        try {
          rev = await disk.write(SEGMENTS_DOC_KEY, { segments: next.segments }, base.revision);
        } catch {
          continue;
        }
        if (rev == null) continue;
        loaded = true;
        adopt({ ...next, revision: rev });
        return;
      }
      throw new Error("The chat's tidy record couldn't be saved.");
    });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    load,
    doc: () => file,
    loaded: () => loaded,
    add: (segment) => write((base) => withSegment(base, segment)),
    forget: (sessionId) =>
      write((base) => (base.segments.some((segment) => segment.sessionId === sessionId) ? { ...base, segments: base.segments.filter((segment) => segment.sessionId !== sessionId) } : base)),
    subscribe(fn) {
      listeners.add(fn);
      void load().catch(() => undefined);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let active: SegmentStore | undefined;

export function segmentStore(): SegmentStore {
  if (active) return active;
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  active = createSegmentStore(inTauri ? tauriLocalHubDisk : memoryDisk());
  return active;
}

/** Tests hand in their own. */
export function setSegmentStore(next: SegmentStore | undefined): void {
  active = next;
}
