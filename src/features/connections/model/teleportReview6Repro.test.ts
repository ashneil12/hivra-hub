// PR #214 hard review, round 6: red repro for the base64 decoder in a9ace2a46. Each case states the RIGHT outcome. Keys
// are made here from random bytes, so no key is stored in the repository.
//
// collectBase64Runs joins every consecutive pure-base64 line (4+ characters) into one run, and decodedPemMatchesHeader
// decodes that run only from its first character. A run that holds a key but does not decode to its header (a short
// word before it that is not a multiple of 4 characters, or a padded encoding or a word such as EOF after a padded one)
// is "not a key", and every line in it is then skipped by the one-line marker scan. f8a00e0ef held all of these through
// its one-line LS0tLS1CRUdJTi match, so this is a regression for a key at byte offset 0 as well.
import { describe, expect, it } from "vitest";
import { planMove, redactChat, type ChatSnapshot } from "./teleport";

const DASHES = "-----";

function randomBase64(bytes: number, seed: number): string {
  const out = new Uint8Array(bytes);
  let x = seed;
  for (let i = 0; i < bytes; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 16;
  }
  return Buffer.from(out).toString("base64");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines;
}

/** A PKCS#8 key file as `openssl genpkey` writes it. */
function keyFile(bytes = 1190): string {
  const body = wrap(randomBase64(bytes, 11), 64).join("\n");
  return `${DASHES}BEGIN PRIVATE KEY${DASHES}\n${body}\n${DASHES}END PRIVATE KEY${DASHES}\n`;
}

/** The key file's base64, chosen so the encoding ends with `=` padding (two in three key files do). */
function paddedKeyBase64(): string {
  for (let bytes = 1190; bytes < 1200; bytes += 1) {
    const encoded = Buffer.from(keyFile(bytes)).toString("base64");
    if (encoded.endsWith("=")) return encoded;
  }
  throw new Error("no key size gives a padded encoding");
}

function certFile(): string {
  const body = wrap(randomBase64(900, 7), 64).join("\n");
  return `${DASHES}BEGIN CERTIFICATE${DASHES}\n${body}\n${DASHES}END CERTIFICATE${DASHES}\n`;
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-r6r",
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
    effort: "high",
    title: "Keys",
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Encode the key for the CI secret" },
      { id: "t1", role: "tool", text: "", tool: { title: "Bash", detail } },
    ]),
    queued: [],
    turnRunning: false,
    approvalPending: false,
  };
}

/** A tool block in the order apply.ts writes it: callId, title, kind, status, detail, command, times. */
function appliedToolChat(status: string, detail: string): ChatSnapshot {
  return {
    ...chatWith(""),
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Encode the key for the CI secret" },
      {
        id: "b2",
        role: "tool",
        text: "Run base64",
        tool: { callId: "toolu_01", title: "Run base64", kind: "execute", status, detail, command: "base64 -w 64 key.pem", startedAt: 1, updatedAt: 2 },
      },
    ]),
  };
}

/** Held, or how many of the encoded key's lines (after the first) would reach the other machine as they are. */
async function outcome(chat: ChatSnapshot, lines: string[]): Promise<string> {
  const planned = await planMove(chat, "this-mac", "host-a");
  if (!planned.ok) return planned.refusal.reason;
  const travels = redactChat(chat).chat.transcript;
  const leaked = lines.filter((line) => travels.includes(line)).length;
  return leaked > 0 ? `travels: ${leaked} of ${lines.length} encoded lines` : "redacted";
}

describe("PR 214 review r6 (HIGH): a base64 key in a run that does not decode from its first character", () => {
  it("a key written with a heredoc, the EOF line right after its padded last line, holds the move", async () => {
    const lines = wrap(paddedKeyBase64(), 76);
    const detail = `$ cat > key.b64 <<EOF\n${lines.join("\n")}\nEOF\n$ chmod 600 key.b64`;
    expect(await outcome(chatWith(detail), lines.slice(1))).toBe("private-key-held");
  });

  // Control, green on 456357592: the same lines with the EOF line one blank line further down.
  it("control: the same heredoc with a blank line before EOF holds the move", async () => {
    const lines = wrap(paddedKeyBase64(), 76);
    const detail = `$ cat > key.b64 <<EOF\n${lines.join("\n")}\n\nEOF\n$ chmod 600 key.b64`;
    expect(await outcome(chatWith(detail), lines.slice(1))).toBe("private-key-held");
  });

  it("a key whose encoding follows a one-word label line holds the move", async () => {
    const lines = wrap(Buffer.from(keyFile()).toString("base64"), 64);
    const detail = `$ cat secrets.txt\napikey\n${lines.join("\n")}`;
    expect(await outcome(chatWith(detail), lines.slice(1))).toBe("private-key-held");
  });

  it("a certificate's encoding then a key's encoding, printed together, holds the move", async () => {
    const cert = Buffer.from(certFile()).toString("base64");
    const key = Buffer.from(keyFile()).toString("base64");
    expect(cert.endsWith("=")).toBe(true);
    const keyLines = wrap(key, 76);
    const detail = `$ cat tls.crt.b64 tls.key.b64\n${[...wrap(cert, 76), ...keyLines].join("\n")}`;
    expect(await outcome(chatWith(detail), keyLines.slice(1))).toBe("private-key-held");
  });

  // The hold reads the chat's strings joined with newlines, so the status word written just before the tool's output is
  // the first line of the run. "completed" happens to follow "execute" (16 characters, aligned); these do not.
  for (const status of ["failed", "done", "running"]) {
    it(`a key printed by a tool whose status is ${status} holds the move`, async () => {
      const lines = wrap(Buffer.from(keyFile()).toString("base64"), 64);
      expect(await outcome(appliedToolChat(status, lines.join("\n")), lines.slice(1))).toBe("private-key-held");
    });
  }
});

describe("PR 214 review r6 (MED): the marker scan is quadratic when a marker is absent", () => {
  // markerIndex runs indexOf for all three markers from each word. A marker that is not in the line is searched to the
  // end of the line again for every word. 1 MB of these words took 67 s to plan and 33 s to redact on 456357592.
  it("a quarter megabyte of space-separated begin markers plans and redacts in under 500 ms", async () => {
    const detail = "LS0tLS1CRUdJTi ".repeat(Math.ceil((256 * 1024) / 15));
    let started = performance.now();
    const planned = await planMove(chatWith(detail), "this-mac", "host-a");
    const plan = performance.now() - started;
    started = performance.now();
    redactChat(chatWith(detail));
    const redact = performance.now() - started;
    expect(planned.ok).toBe(true);
    expect(plan, `plan ${Math.round(plan)} ms`).toBeLessThan(500);
    expect(redact, `redact ${Math.round(redact)} ms`).toBeLessThan(500);
  }, 120_000);
});
