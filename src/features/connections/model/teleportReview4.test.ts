// PR #214 hard review, round 4: red repro for a private key the hold claims and misses. The case states the RIGHT outcome.
// The keys are made here from random bytes, so no key is stored in the repository.
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

/** A key file as `openssl genpkey` (PKCS#8), `openssl ecparam -genkey` (EC) or `ssh-keygen` (OpenSSH) writes it. */
function keyFile(kind: "" | "EC " | "OPENSSH "): string {
  const body = wrap(randomBase64(1190, 7), 64).join("\n");
  return `${DASHES}BEGIN ${kind}PRIVATE KEY${DASHES}\n${body}\n${DASHES}END ${kind}PRIVATE KEY${DASHES}\n`;
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-r4",
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
    effort: "high",
    title: "Keys",
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Encode the key for the secret" },
      { id: "t1", role: "tool", text: "", tool: { title: "Bash", detail } },
    ]),
    queued: [],
    turnRunning: false,
    approvalPending: false,
  };
}

/** Held, or how many of the encoded key's lines would reach the other machine. */
async function outcome(detail: string, lines: string[]): Promise<string> {
  const planned = await planMove(chatWith(detail), "this-mac", "host-a");
  if (!planned.ok) return planned.refusal.reason;
  const travels = redactChat(chatWith(detail)).chat.transcript;
  const leaked = lines.filter((line) => travels.includes(line)).length;
  return leaked > 0 ? `travels: ${leaked} of ${lines.length} key lines` : "redacted";
}

describe("PR 214 review r4 (HIGH): a base64 key file the hold claims to hold", () => {
  // The PR body says a base64 encoding of a PEM header is held. PRIVATE_KEY_HEADER looks for base64("PRIVATE") only at the
  // one alignment where "PRIVATE" starts at a multiple of 3 bytes (RSA, DSA, ENCRYPTED, PGP). In PKCS#8 ("BEGIN PRIVATE
  // KEY"), EC and OpenSSH key files it starts elsewhere, so the encoded header is a different string. `openssl base64` and
  // GNU `base64` wrap their output (64 and 76 columns), so the one-line BASE64_PEM redaction removes the first line only and
  // every other line of the encoded key goes to the host as it is. Decoding them gives the key back.
  for (const [kind, label] of [
    ["", "PKCS#8"],
    ["EC ", "EC"],
    ["OPENSSH ", "OpenSSH"],
  ] as const) {
    for (const width of [64, 76]) {
      it(`a ${label} key file encoded with base64 at ${width} columns holds the move`, async () => {
        const encoded = wrap(Buffer.from(keyFile(kind)).toString("base64"), width);
        const detail = `$ openssl base64 -in key.pem\n${encoded.join("\n")}`;
        expect(await outcome(detail, encoded.slice(1))).toBe("private-key-held");
      });
    }
  }
});
