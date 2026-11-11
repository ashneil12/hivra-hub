// PR #214 hard review, round 5: red repro for a base64 private key the hold claims and misses. Each case states the RIGHT
// outcome. The keys are made here from random bytes, so no key is stored in the repository.
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
function keyFile(): string {
  const body = wrap(randomBase64(1190, 11), 64).join("\n");
  return `${DASHES}BEGIN PRIVATE KEY${DASHES}\n${body}\n${DASHES}END PRIVATE KEY${DASHES}\n`;
}

/** A cloud service-account key file: JSON whose private_key field holds the PEM with `\n` escapes. */
function serviceAccountJson(projectId: string): string {
  return JSON.stringify(
    {
      type: "service_account",
      project_id: projectId,
      private_key_id: "0123456789abcdef0123456789abcdef01234567",
      private_key: keyFile(),
      client_email: `deploy@${projectId}.iam.example`,
    },
    null,
    2,
  );
}

/** A project id that puts the key's "-----BEGIN" at this byte offset mod 3, so the test does not hang on one id. */
function serviceAccountAt(offset: 0 | 1 | 2): string {
  for (let length = 4; length < 7; length += 1) {
    const json = serviceAccountJson("p".repeat(length));
    if (json.indexOf(`${DASHES}BEGIN`) % 3 === offset) return json;
  }
  throw new Error("no project id gives that offset");
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-r5",
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

/** Held, or how many of the encoded file's lines (after the first) would reach the other machine as they are. */
async function outcome(detail: string, lines: string[]): Promise<string> {
  const planned = await planMove(chatWith(detail), "this-mac", "host-a");
  if (!planned.ok) return planned.refusal.reason;
  const travels = redactChat(chatWith(detail)).chat.transcript;
  const leaked = lines.filter((line) => travels.includes(line)).length;
  return leaked > 0 ? `travels: ${leaked} of ${lines.length} encoded lines` : "redacted";
}

describe("PR 214 review r5 (HIGH): a base64 PEM header that does not start on a 3-byte boundary", () => {
  // The hold and the redaction look for PEM_MARKER, base64("-----BEGIN") when "-----BEGIN" starts at a byte offset
  // divisible by 3. With one or two bytes before it the encoding is "...0tLS0tQkVHSU4..." or "...tLS0tLUJFR0lO...", so a
  // key file with a leading blank line, or a key inside an encoded JSON or env file, is neither held nor redacted. The
  // r4 fix moved the alignment problem from "PRIVATE" to "-----BEGIN".
  it("a key file with one leading newline, encoded with base64 at 76 columns, holds the move", async () => {
    const encoded = wrap(Buffer.from(`\n${keyFile()}`).toString("base64"), 76);
    const detail = `$ base64 key.pem\n${encoded.join("\n")}`;
    expect(await outcome(detail, encoded.slice(1))).toBe("private-key-held");
  });

  it("a key file with two leading bytes, encoded with base64 at 64 columns, holds the move", async () => {
    const encoded = wrap(Buffer.from(`\r\n${keyFile()}`).toString("base64"), 64);
    const detail = `$ openssl base64 -in key.pem\n${encoded.join("\n")}`;
    expect(await outcome(detail, encoded.slice(1))).toBe("private-key-held");
  });

  for (const offset of [1, 2] as const) {
    it(`a service-account JSON encoded with base64, its key at byte offset ${offset} mod 3, holds the move`, async () => {
      const encoded = wrap(Buffer.from(serviceAccountAt(offset)).toString("base64"), 76);
      const detail = `$ base64 -i service-account.json\n${encoded.join("\n")}`;
      expect(await outcome(detail, encoded.slice(1))).toBe("private-key-held");
    });
  }

  // Control, green on f8a00e0ef: the same file with its key at offset 0 mod 3 is held, so only the alignment differs.
  it("control: the same service-account JSON with its key at byte offset 0 mod 3 holds the move", async () => {
    const encoded = wrap(Buffer.from(serviceAccountAt(0)).toString("base64"), 76);
    const detail = `$ base64 -i service-account.json\n${encoded.join("\n")}`;
    expect(await outcome(detail, encoded.slice(1))).toBe("private-key-held");
  });
});
