// The ask ledger on disk: one document (`asks`) in the app's own database (src-tauri/src/local_hub.rs), so it rides
// with the chats through a ship's backup and rollback and is nowhere near a chat's context. Every window reads the
// same one. A write lands only on the revision just read; another window's write means read again and apply on top.

import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import {
  ASK_DOC_KEY,
  askDocForDisk,
  emptyAskDoc,
  parseAskDoc,
  withAdded,
  withChange,
  withHeard,
  type Ask,
  type AskBy,
  type AskChange,
  type AskDoc,
  type HearInput,
} from "./asks";

const TRIES = 5;

export type AskStore = {
  load(): Promise<AskDoc>;
  /** Writes the empty ledger once, so the day it began is kept and not counted again from each launch. */
  begin(): Promise<void>;
  /** The ledger as this window last read it. Empty until the first load. */
  doc(): AskDoc;
  loaded(): boolean;
  hear(input: HearInput): Promise<void>;
  change(id: string | number, change: AskChange, by: AskBy): Promise<{ ask: Ask } | { problem: string }>;
  add(input: { mateId: string; sessionId: string; blockId: string; text: string }): Promise<void>;
  subscribe(fn: () => void): () => void;
};

export function createAskStore(disk: LocalHubDisk, now: () => number = Date.now): AskStore {
  let file: AskDoc = emptyAskDoc(now());
  let loaded = false;
  let watching = false;
  let first: Promise<AskDoc> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const adopt = (next: AskDoc) => {
    if (loaded && next.revision < file.revision) return;
    file = next;
    for (const fn of [...listeners]) fn();
  };
  const read = async () => {
    const doc = await disk.readDoc(ASK_DOC_KEY);
    return parseAskDoc(doc.value, doc.rev, now());
  };
  const refresh = async () => {
    const next = await read();
    adopt(next);
    loaded = true;
    if (!watching && disk.watch) {
      watching = true;
      disk.watch((key, rev) => {
        if (key === ASK_DOC_KEY && rev > file.revision) void refresh().catch(() => undefined);
      });
    }
    return file;
  };
  // One first read however many readers ask at once (every receipt in a long chat subscribes).
  const load = (): Promise<AskDoc> => {
    if (loaded) return Promise.resolve(file);
    first ??= refresh().finally(() => {
      first = undefined;
    });
    return first;
  };
  const write = <R>(fn: (base: AskDoc) => { doc: AskDoc; result: R }): Promise<R> => {
    const run = chain.then(async () => {
      for (let attempt = 0; attempt < TRIES; attempt += 1) {
        let base: AskDoc;
        try {
          base = await read();
        } catch {
          continue;
        }
        const { doc, result } = fn(base);
        if (doc === base) return result;
        let rev: number | null;
        try {
          rev = await disk.write(ASK_DOC_KEY, askDocForDisk(doc), base.revision);
        } catch {
          continue;
        }
        if (rev == null) continue;
        loaded = true;
        adopt({ ...doc, revision: rev });
        return result;
      }
      throw new Error("The ask list couldn't be saved. Try again.");
    });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    load,
    begin: () => write((base) => ({ doc: base.revision === 0 ? { ...base } : base, result: undefined })),
    doc: () => file,
    loaded: () => loaded,
    hear: (input) => write((base) => ({ doc: withHeard(base, input), result: undefined })),
    change: (id, change, by) =>
      write<{ ask: Ask } | { problem: string }>((base) => {
        const out = withChange(base, id, change, by, now());
        return "problem" in out ? { doc: base, result: out } : { doc: out.doc, result: { ask: out.ask } };
      }),
    add: (input) => write((base) => ({ doc: withAdded(base, { ...input, now: now() }), result: undefined })),
    subscribe(fn) {
      listeners.add(fn);
      void load().catch(() => undefined);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let active: AskStore | undefined;

/** The window's ledger: the app's database in the app, memory in a browser preview or a test. */
export function askStore(): AskStore {
  if (active) return active;
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  active = createAskStore(inTauri ? tauriLocalHubDisk : memoryDisk());
  return active;
}

/** Tests hand in their own. */
export function setAskStore(next: AskStore | undefined): void {
  active = next;
}
