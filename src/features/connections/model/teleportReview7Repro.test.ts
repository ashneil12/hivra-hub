// PR #214 hard review, round 7: red repro for the base64 marker scan in f7a736ed8. Each case states the RIGHT outcome.
// Keys are made here from random bytes, so no key is stored in the repository.
//
// f7a736ed8 removed the whole-run decode. A run is now decoded only in 96-character windows next to a base64
// "-----BEGIN" marker (runVerdict returns "clear" at once when no marker is in the text). On 456357592 every pure base64
// run was decoded whole and checked against PRIVATE_KEY_HEADER, which also matches the END armor line, PuTTY, age and
// SSH2 headers. Those keys were held on 456357592 and travel on 6868137f8 (HIGH, regression).
//
// The marker rule is also not fail closed: any window that decodes, at any of the four alignments, counts as "proven
// not a key", so a cut header ("-----BEGIN PRIV") is cleared (MED). Two encodings were never held (MED).
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

const b64 = (text: string) => Buffer.from(text).toString("base64");

/** A PEM key file as openssl writes it. */
function keyFile(label = "PRIVATE KEY", bytes = 1190): string {
  const body = wrap(randomBase64(bytes, 11), 64).join("\n");
  return `${DASHES}BEGIN ${label}${DASHES}\n${body}\n${DASHES}END ${label}${DASHES}\n`;
}

/** A PuTTY .ppk file (version 3, unencrypted), as puttygen writes it. */
function ppkFile(): string {
  return [
    "PuTTY-User-Key-File-3: ssh-ed25519",
    "Encryption: none",
    "Comment: ed25519-key-20261111",
    "Public-Lines: 2",
    ...wrap(randomBase64(51, 3), 64),
    "Private-Lines: 1",
    ...wrap(randomBase64(48, 5), 64),
    `Private-MAC: ${"ab".repeat(32)}`,
    "",
  ].join("\n");
}

/** An age identity file, as age-keygen writes it. */
function ageFile(): string {
  const secret = "QWERTYUPASDFGHJKLZXCVNM023456789".repeat(2).slice(0, 58);
  return `# created: 2026-11-11T10:00:00Z\n# public key: age1${"q".repeat(58)}\nAGE-SECRET-KEY-1${secret}\n`;
}

/** An SSH2 (RFC 4716) private key, as some commercial SSH tools export it. */
function ssh2File(): string {
  const body = wrap(randomBase64(1100, 9), 70).join("\n");
  return `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: "rsa-key"\n${body}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\n`;
}

function chatWith(detail: string): ChatSnapshot {
  return {
    chatId: "chat-r7r",
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

/** Held, or how many of the given encoded pieces would reach the other machine as they are. */
async function outcome(chat: ChatSnapshot, pieces: string[]): Promise<string> {
  const planned = await planMove(chat, "this-mac", "host-a");
  if (!planned.ok) return planned.refusal.reason;
  const travels = redactChat(chat).chat.transcript;
  const leaked = pieces.filter((piece) => travels.includes(piece)).length;
  return leaked > 0 ? `travels: ${leaked} of ${pieces.length} encoded pieces` : "redacted";
}

describe("PR 214 review r7 (HIGH, regression from 456357592): a base64 key with no base64 BEGIN marker", () => {
  it("a base64 PuTTY key file holds the move", async () => {
    const lines = wrap(b64(ppkFile()), 76);
    expect(await outcome(chatWith(`$ base64 id.ppk\n${lines.join("\n")}`), lines.slice(1))).toBe("private-key-held");
  });

  it("a base64 age identity file holds the move", async () => {
    const lines = wrap(b64(ageFile()), 76);
    expect(await outcome(chatWith(`$ base64 keys.txt\n${lines.join("\n")}`), lines.slice(1))).toBe("private-key-held");
  });

  it("a base64 SSH2 private key holds the move", async () => {
    const lines = wrap(b64(ssh2File()), 76);
    expect(await outcome(chatWith(`$ base64 id_rsa.ssh2\n${lines.join("\n")}`), lines.slice(1))).toBe("private-key-held");
  });

  it("a base64 key file printed without its first line (tail) holds the move", async () => {
    const lines = wrap(b64(keyFile()), 76);
    const shown = lines.slice(-12);
    expect(await outcome(chatWith(`$ tail -n 12 key.b64\n${shown.join("\n")}`), shown.slice(0, -2))).toBe("private-key-held");
  });

  it("a base64 EC key file printed from its second line holds the move", async () => {
    const lines = wrap(b64(keyFile("EC PRIVATE KEY", 121)), 76);
    const shown = lines.slice(1);
    expect(await outcome(chatWith(`$ sed -n '2,$p' ec.b64\n${shown.join("\n")}`), shown.slice(0, -1))).toBe("private-key-held");
  });

  it("a base64 key whose first 20 characters are in one message and the rest in the next holds the move", async () => {
    const encoded = b64(keyFile());
    const chat: ChatSnapshot = {
      ...chatWith(""),
      transcript: JSON.stringify([
        { id: "u1", role: "user", text: `here is the start: ${encoded.slice(0, 20)}` },
        { id: "u2", role: "user", text: encoded.slice(20) },
      ]),
    };
    expect(await outcome(chat, wrap(encoded.slice(20), 76).slice(0, 4))).toBe("private-key-held");
  });
});

describe("PR 214 review r7 (MED): a base64 BEGIN marker whose header is cut is not proven harmless", () => {
  // The r6 ask: fail closed on any -----BEGIN marker unless proven non-private. A window decoded at the wrong alignment,
  // or a header cut by a character the scan does not strip, is not proof. Short wraps keep the marker on its own line.
  for (const [name, separator] of [
    ["a Unicode line separator", " "],
    ["a no-break space", " "],
    ["a quoted reply prefix", "\n> "],
  ] as const) {
    it(`a base64 key wrapped at 16 columns with ${name} holds the move`, async () => {
      const lines = wrap(b64(keyFile()), 16);
      expect(await outcome(chatWith(lines.join(separator)), lines.slice(10, 40))).toBe("private-key-held");
    });
  }
});

describe("PR 214 review r7 (MED): encodings of a PEM key that were never held", () => {
  it("a URL-encoded key file (a form post or a webhook log) holds the move", async () => {
    const encoded = encodeURIComponent(keyFile());
    expect(await outcome(chatWith(`POST /deploy body: key=${encoded}`), [encoded.slice(200, 260)])).toBe("private-key-held");
  });

  it("a key file encoded twice (a base64 of a Kubernetes secret manifest) holds the move", async () => {
    const twice = b64(`apiVersion: v1\nkind: Secret\ndata:\n  tls.key: ${b64(keyFile())}\n`);
    expect(await outcome(chatWith(twice), [twice.slice(400, 460)])).toBe("private-key-held");
  });
});
