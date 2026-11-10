import {
  IMPORT_FILE_NAMES,
  commitPins,
  emptyPins,
  insideProject,
  parsePinDocument,
  serializePinDocument,
  type PinChange,
  type PinDocument,
} from "./pins";

/** A timeout is not a final failure. Anything else we raise here is. */
export class PinIoError extends Error {
  readonly final: boolean;

  constructor(message: string, final: boolean) {
    super(message);
    this.name = "PinIoError";
    this.final = final;
  }
}

export type PinIo = {
  read(projectRoot: string): Promise<{ text: string | null }>;
  /** False when `expectedRevision` is no longer the file's revision. */
  write(projectRoot: string, text: string, expectedRevision: number): Promise<boolean>;
};

export function memoryPinIo(initial: string | null = null): PinIo & { text(): string | null } {
  let text = initial;
  return {
    text: () => text,
    async read() {
      return { text };
    },
    async write(_root, body, expected) {
      const current = parsePinDocument(text);
      if (current.revision !== expected) return false;
      const next = parsePinDocument(body);
      if (next.revision !== expected + 1) return false;
      text = body;
      return true;
    },
  };
}

function asPinError(error: unknown, fallback: string): PinIoError {
  if (error instanceof PinIoError) return error;
  const message = error instanceof Error ? error.message : "";
  const timeout = /timed out|timeout/i.test(message);
  return new PinIoError(timeout ? "Could not reach the pin list this time." : fallback, !timeout);
}

export async function loadPins(io: PinIo, root: string): Promise<PinDocument> {
  try {
    const { text } = await io.read(root);
    return parsePinDocument(text);
  } catch (error) {
    throw asPinError(error, "Could not read the pin list.");
  }
}

/**
 * Apply `change` on top of the latest list. Another window's save makes this
 * read again. A stop before the write leaves the file alone.
 */
export async function savePins(
  io: PinIo,
  root: string,
  change: (doc: PinDocument) => PinChange,
  signal?: { aborted: boolean },
): Promise<PinDocument> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new PinIoError("Stopped.", false);
    const current = await loadPins(io, root);
    if (signal?.aborted) throw new PinIoError("Stopped.", false);
    const next = change(current);
    const committed = commitPins(current, current.revision, next);
    if (!committed.ok) continue;
    try {
      const wrote = await io.write(root, serializePinDocument(committed.document), current.revision);
      if (wrote) return committed.document;
    } catch (error) {
      throw asPinError(error, "Could not save the pin list.");
    }
  }
  throw new PinIoError("The pin list changed. Try again.", false);
}

export function ioKind(error: unknown): "missing" | "timeout" | "other" {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/not found|no such file|os error 2|enoent/i.test(message)) return "missing";
  return "other";
}

/** The pin file in a folder the person picked. `repo-pins.json` wins. */
export async function textFromFolder(
  folder: string,
  read: (path: string) => Promise<string>,
): Promise<{ name: string; text: string }> {
  let sawTimeout = false;
  for (const name of IMPORT_FILE_NAMES) {
    const path = insideProject(folder, name);
    if (!path) continue;
    try {
      return { name, text: await read(path) };
    } catch (error) {
      const kind = ioKind(error);
      if (kind === "missing") continue;
      if (kind === "timeout") {
        sawTimeout = true;
        break;
      }
      throw new PinIoError("Could not read that folder.", true);
    }
  }
  if (sawTimeout) throw new PinIoError("Could not read that folder this time.", false);
  throw new PinIoError("That folder has no pin file.", true);
}

export function pinsOptedIn(text: string | null): boolean {
  return text !== null && text.trim() !== "";
}

export { emptyPins };
