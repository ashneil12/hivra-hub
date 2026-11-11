// PR #214 hard review, round 6. Keys are made here from random bytes, so no key is stored in the repository.
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

function keyFile(): string {
  const body = wrap(randomBase64(1190, 11), 64).join("\n");
  return `${DASHES}BEGIN PRIVATE KEY${DASHES}\n${body}\n${DASHES}END PRIVATE KEY${DASHES}\n`;
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-r6",
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

async function outcome(detail: string): Promise<string> {
  const planned = await planMove(chatWith(detail), "this-mac", "host-a");
  return planned.ok ? "travels" : planned.refusal.reason;
}

describe("PR 214 review r6: base64 that is not on a 3-byte boundary, and redaction time", () => {
  it("a one-line token with one leading byte holds the move", async () => {
    const encoded = Buffer.from(`\n${keyFile()}`).toString("base64");
    expect(await outcome(`token ${encoded}`)).toBe("private-key-held");
  });

  it("a one-line token with two leading bytes holds the move", async () => {
    const encoded = Buffer.from(`\r\n${keyFile()}`).toString("base64");
    expect(await outcome(`token ${encoded}`)).toBe("private-key-held");
  });

  it("a misaligned encoding whose length mod 4 is 1 still holds the move", async () => {
    const encoded = Buffer.from(`\n${keyFile()}`).toString("base64");
    const chopped = encoded.slice(0, -3);
    expect(chopped.length % 4).toBe(1);
    expect(await outcome(chopped)).toBe("private-key-held");
  });

  it("a prefixed key wrapped so the last line is 3 characters still holds the move", async () => {
    const widths = [57, 61, 65, 69, 77];
    let detail = "";
    for (const width of widths) {
      for (let extra = 1; extra < width * 4; extra += 1) {
        const candidate = `${"\n".repeat(extra)}${keyFile()}`;
        if (candidate.indexOf(`${DASHES}BEGIN`) % 3 === 0) continue;
        const encoded = Buffer.from(candidate).toString("base64");
        if (encoded.length % width !== 3) continue;
        detail = wrap(encoded, width).join("\n");
        break;
      }
      if (detail) break;
    }
    expect(detail.length).toBeGreaterThan(0);
    expect(await outcome(detail)).toBe("private-key-held");
  });

  it("a megabyte of base64 with no key finishes under 500 ms", () => {
    const detail = `${"A".repeat(76)}\n`.repeat(Math.ceil((1024 * 1024) / 77));
    const started = performance.now();
    const out = redactChat(chatWith(detail));
    const elapsed = performance.now() - started;
    expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(500);
    expect(out.chat.transcript.length).toBeGreaterThan(0);
  }, 90_000);

  it("a long line of repeated begin markers is not a private key and finishes under 500 ms", async () => {
    const detail = "LS0tLS1CRUdJTi".repeat(20_480);
    const started = performance.now();
    const planned = await planMove(chatWith(detail), "this-mac", "host-a");
    const elapsed = performance.now() - started;
    expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(500);
    expect(planned.ok).toBe(true);
  }, 90_000);
});
