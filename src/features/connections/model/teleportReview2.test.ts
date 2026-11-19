// PR #214 hard review, round 2: red repros for what a move carries. Each case states the RIGHT outcome.
// The move promises that a private key holds the move ("A private key is in this chat, so the move is held") and that
// every other secret is redacted before it travels. These key forms pass the plan with nothing redacted.
import { describe, expect, it } from "vitest";
import { planMove, redactChat, type ChatSnapshot } from "./teleport";

function chatWith(text: string, extra: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    chatId: "chat-r2",
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
    effort: "high",
    title: "Keys",
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Here is the key file:" },
      { id: "a1", role: "assistant", text },
    ]),
    queued: [],
    turnRunning: false,
    approvalPending: false,
    ...extra,
  };
}

/** Held, or nothing of the secret left in what would travel. */
async function heldOrRedacted(text: string, secret: string) {
  const planned = await planMove(chatWith(text), "this-mac", "host-a");
  if (!planned.ok) return planned.refusal.reason;
  return redactChat(chatWith(text)).chat.transcript.includes(secret) ? "travels" : "redacted";
}

describe("PR 214 review r2: private keys that travel in a move", () => {
  it("a PGP private key block holds the move (its armor line is 'PRIVATE KEY BLOCK-----', not 'PRIVATE KEY-----')", async () => {
    const body = "lQOYBF0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV";
    const text = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${body}\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(await heldOrRedacted(text, body)).toBe("private-key-held");
  });

  it("a PuTTY private key (.ppk) holds the move", async () => {
    const secret = "AAAAIFZr8m3kq9sQ2x7pLwT4vN1cYb6dJ0hUeRfGaKiMoPqS";
    const text = `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: me\nPublic-Lines: 2\nAAAAC3NzaC1lZDI1NTE5AAAAIOk\nPrivate-Lines: 1\n${secret}\nPrivate-MAC: 1b2c3d4e5f60718293a4b5c6d7e8f901`;
    expect(await heldOrRedacted(text, secret)).toBe("private-key-held");
  });

  it("an age secret key does not travel", async () => {
    const secret = "AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS3SPZM3";
    expect(await heldOrRedacted(`identity: ${secret}`, secret)).not.toBe("travels");
  });
});

describe("PR 214 review r2 (LOW): settings travel unredacted", () => {
  it("a key-shaped model setting is redacted like the transcript, or not carried", () => {
    // carriedSettings (teleportLocal.ts) copies any short string setting; redactChat never looks at modelSettings, and the
    // manifest check does not cover them, so a key stored as a setting reaches the host's disk as it is.
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const redacted = redactChat(chatWith("nothing secret here", { modelSettings: { effort: "high", token: secret } })).chat;
    expect(JSON.stringify(redacted.modelSettings ?? {})).not.toContain(secret);
  });
});

describe("PR 214 review r2 (LOW): one device key for every host", () => {
  it("each host is sent its own device key, so one host cannot act as this Mac on another", async () => {
    // host/server.ts takes the device from the claimed deviceKey alone (the bearer token is not mixed in). The same key
    // goes to every paired host, so whoever runs host A learns the key that owns this Mac's moved chats on host B.
    const { sshMoveEndpoint } = await import("./teleportSsh");
    const seen: Record<string, unknown> = {};
    const capture = (host: string) => async (_method: string, params: Record<string, unknown>) => {
      seen[host] = params.deviceKey;
      return null;
    };
    await sshMoveEndpoint("host-a", capture("host-a")).read("chat-r2");
    await sshMoveEndpoint("host-b", capture("host-b")).read("chat-r2");
    expect(seen["host-a"]).toBeTruthy();
    expect(seen["host-a"]).not.toBe(seen["host-b"]);
  });
});
