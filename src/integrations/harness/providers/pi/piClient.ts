import { writeChild } from "../../core/child";
import { parseJsonLine, parseRpcResponse, stringField } from "./piProtocol";

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/** What omp (18.4+) puts in a v1 response that would not fit one 1 MiB line. */
export const RPC_TRANSPORT_LIMIT_ERROR =
  "RPC response exceeded the transport limit";
/** omp's own ceiling for one reassembled frame (`maxReassembledFrameBytes`). */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

type ChunkBuffer = {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  parts: Uint8Array[];
  receivedBytes: number;
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * JSONL request/response multiplexer for `pi --mode rpc` and the identical
 * `omp --mode rpc`. Agent events and extension UI frames go to `onFrame`.
 *
 * omp starts on protocol 1, where one line is capped at 1 MiB: a bigger
 * response comes back as `success: false` with RPC_TRANSPORT_LIMIT_ERROR
 * (its model list with OpenRouter is about 1.7 MB) and a bigger `agent_end`
 * loses its messages. Its `ready` frame offers protocol 2, which splits big
 * frames into `rpc_chunk` lines. As soon as `ready` offers it, this client
 * negotiates protocol 2 and reassembles chunks, and a request that still
 * hit the limit (sent before the negotiation landed) is sent once more.
 * Pi, which offers no protocol 2, is left exactly as it was.
 */
export class PiRpc {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private chunk: ChunkBuffer | undefined;
  /** Settles true once protocol 2 is on, false if it was offered but refused. */
  private framing: Promise<boolean> | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly onFrame: (rec: Record<string, unknown>) => void,
    private readonly label = "Pi",
  ) {}

  pushLine(line: string) {
    const parsed = parseJsonLine(line);
    if (!parsed) return;
    const rec =
      stringField(parsed, "type") === "rpc_chunk"
        ? this.pushChunk(parsed)
        : this.endChunkSequence(parsed);
    if (!rec) return;
    if (stringField(rec, "type") === "ready") this.offerFraming(rec);
    const response = parseRpcResponse(rec);
    if (response?.id && this.pending.has(response.id)) {
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      if (!pending) return;
      if (!response.success) {
        pending.reject(
          new Error(response.error || `${this.label} ${response.command} failed`),
        );
        return;
      }
      pending.resolve(rec);
      return;
    }
    this.onFrame(rec);
  }

  async request(
    command: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.send(command, timeoutMs);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== RPC_TRANSPORT_LIMIT_ERROR ||
        !this.framing ||
        stringField(command, "type") === "negotiate_protocol" ||
        // A caller-chosen id (a prompt) is one the caller may cancel by.
        stringField(command, "id") !== undefined
      ) {
        throw error;
      }
      if (!(await this.framing)) throw error;
      // The first answer was cut by the 1 MiB line cap before protocol 2 was
      // on; send it again under a fresh id.
      return this.send(command, timeoutMs);
    }
  }

  private async send(
    command: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error(`${this.label} process is not running`);
    const id = stringField(command, "id") ?? `mc_${this.nextId++}`;
    if (this.pending.has(id)) throw new Error(`Duplicate RPC request id: ${id}`);
    const payload = { ...command, id };
    const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const type = stringField(command, "type") ?? "command";
        reject(new Error(`${this.label} ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    void writeChild(this.sessionId, JSON.stringify(payload)).catch((error) => {
      const message =
        error instanceof Error ? error : new Error(String(error));
      const request = this.pending.get(id);
      this.pending.delete(id);
      request?.reject(message);
    });
    return pending;
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.chunk = undefined;
    const err = error ?? new Error(`${this.label} process exited`);
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  cancelRequest(id: string): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.reject(new Error(`${this.label} request cancelled`));
  }

  private offerFraming(ready: Record<string, unknown>) {
    if (this.framing || this.closed) return;
    const versions = ready.supportedProtocolVersions;
    if (!Array.isArray(versions) || !versions.includes(2)) return;
    this.framing = this.send(
      { type: "negotiate_protocol", protocolVersion: 2 },
      15_000,
    ).then(
      () => true,
      (error: unknown) => {
        console.debug(`[monocode] ${this.label} protocol 2 refused`, error);
        return false;
      },
    );
  }

  /** A whole frame between chunks breaks the sequence: drop the partial one. */
  private endChunkSequence(rec: Record<string, unknown>) {
    if (this.chunk) {
      console.debug(`[monocode] ${this.label} rpc chunk sequence interrupted`);
      this.chunk = undefined;
    }
    return rec;
  }

  /** Collect one `rpc_chunk`; the last one yields the reassembled frame. */
  private pushChunk(
    rec: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const { chunkId, index, count, byteLength, data } = rec;
    const fail = (why: string) => {
      console.debug(`[monocode] ${this.label} rpc chunk dropped: ${why}`);
      this.chunk = undefined;
      return null;
    };
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      typeof data !== "string" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (count as number) < 1 ||
      (index as number) < 0 ||
      (index as number) >= (count as number) ||
      (byteLength as number) <= 0 ||
      (byteLength as number) > MAX_REASSEMBLED_BYTES
    ) {
      return fail("bad metadata");
    }
    if (index === 0) {
      if (this.chunk) fail("new sequence before the last one finished");
      this.chunk = {
        chunkId,
        count: count as number,
        byteLength: byteLength as number,
        nextIndex: 0,
        parts: [],
        receivedBytes: 0,
      };
    }
    const buffer = this.chunk;
    if (
      !buffer ||
      buffer.chunkId !== chunkId ||
      buffer.count !== count ||
      buffer.byteLength !== byteLength ||
      buffer.nextIndex !== index
    ) {
      return fail("out of sequence");
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      return fail("bad base64");
    }
    buffer.parts.push(bytes);
    buffer.receivedBytes += bytes.byteLength;
    buffer.nextIndex++;
    if (buffer.receivedBytes > buffer.byteLength) return fail("too long");
    if (buffer.nextIndex < buffer.count) return null;
    this.chunk = undefined;
    if (buffer.receivedBytes !== buffer.byteLength) return fail("length mismatch");
    const whole = new Uint8Array(buffer.byteLength);
    let offset = 0;
    for (const part of buffer.parts) {
      whole.set(part, offset);
      offset += part.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
    } catch {
      return fail("not UTF-8");
    }
    return parseJsonLine(text) ?? fail("not a JSON object");
  }
}
