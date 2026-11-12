// The key hold fails closed. A marker window is not proof unless it decodes to a complete allow-listed BEGIN line.
// A header phrase anywhere in a long run still holds, without decoding the whole run. Keys are made here from random
// bytes, so no key is stored in the repository.
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

function pem(label: string, bytes: number): string {
  const body = wrap(randomBase64(bytes, 11), 64).join("\n");
  return `${DASHES}BEGIN ${label}${DASHES}\n${body}\n${DASHES}END ${label}${DASHES}\n`;
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-hold",
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
    effort: "high",
    title: "Keys",
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Show the file" },
      { id: "t1", role: "tool", text: "", tool: { title: "Bash", detail } },
    ]),
    queued: [],
    turnRunning: false,
    approvalPending: false,
  };
}

async function planReason(detail: string): Promise<string> {
  const planned = await planMove(chatWith(detail), "this-mac", "host-a");
  return planned.ok ? "travels" : planned.refusal.reason;
}

describe("key hold fails closed", () => {
  it("a cut BEGIN label is not proof, so the move is held", async () => {
    const encoded = Buffer.from(`${DASHES}BEGIN PRIV`).toString("base64");
    expect(await planReason(encoded)).toBe("private-key-held");
  });

  it("a certificate travels", async () => {
    const encoded = Buffer.from(pem("CERTIFICATE", 400)).toString("base64");
    expect(await planReason(wrap(encoded, 64).join("\n"))).toBe("travels");
  });

  it("a public key travels", async () => {
    const encoded = Buffer.from(pem("PUBLIC KEY", 200)).toString("base64");
    expect(await planReason(wrap(encoded, 64).join("\n"))).toBe("travels");
  });

  it("a PuTTY key buried in a long base64 run holds the move", async () => {
    const ppk = [
      "PuTTY-User-Key-File-3: ssh-ed25519",
      "Encryption: none",
      "Comment: ed25519-key",
      "Public-Lines: 1",
      randomBase64(32, 3),
      "Private-Lines: 1",
      randomBase64(32, 5),
      `Private-MAC: ${"ab".repeat(32)}`,
      "",
    ].join("\n");
    const encoded = Buffer.from(ppk).toString("base64");
    for (const lead of [0, 1, 2]) {
      const padded = `${"A".repeat(40_000 + lead)}${encoded}${"A".repeat(40_000)}`;
      expect(padded.length).toBeGreaterThan(32_768);
      expect(await planReason(padded)).toBe("private-key-held");
    }
  });

  it("a 1 MB adversarial scan grows about linearly from a 64 KB one", () => {
    // The guard is against a scan that blows up with size (backtracking, a decode per offset). The baseline is the
    // same adversarial text at 1/16 of the size, not a tiny run: a tiny run is mostly fixed cost, so on a busy
    // machine its ratio to the 1 MB run swung past the bound without the scan changing (12 Nov, load 17-26).
    const line = "LS0tLS1CRUdJTiX";
    const big = line.repeat(Math.ceil((1024 * 1024) / line.length));
    const part = line.repeat(Math.ceil((64 * 1024) / line.length));
    const median = (text: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const started = performance.now();
        redactChat(chatWith(text));
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return samples[1] ?? samples[0] ?? 0;
    };
    // One pass of each size pays for the first compilation. The measured runs are the steady cost.
    redactChat(chatWith(part));
    redactChat(chatWith(big));
    const baseline = Math.max(0.5, median(part));
    const elapsed = median(big);
    // 16 times the text: linear is about 16 times the time, quadratic about 256. Allow 4 times linear for noise.
    expect(elapsed, `${Math.round(elapsed)} ms vs ${baseline.toFixed(2)} ms for 64 KB`).toBeLessThan(baseline * 16 * 4);
    expect(elapsed).toBeLessThan(10_000);
  });
});
