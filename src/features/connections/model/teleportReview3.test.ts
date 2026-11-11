// PR #214 hard review, round 3: red repros for what a move carries and the per-host device key. Each case states the
// RIGHT outcome.
import { describe, expect, it } from "vitest";
import { planMove, redactChat, type ChatSnapshot } from "./teleport";
import { sessionToChat } from "./teleportLocal";
import type { Session } from "../../sessions/model/session";

function chatWith(text: string, extra: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    chatId: "chat-r3",
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
    effort: "high",
    title: "Keys",
    transcript: JSON.stringify([
      { id: "u1", role: "user", text: "Show me the key file" },
      { id: "t1", role: "tool", text: "", tool: { title: "Bash", detail: text } },
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

describe("PR 214 review r3 (MEDIUM): private keys the hold does not see", () => {
  it("an OpenSSH private key body printed without its BEGIN/END lines holds the move", async () => {
    // Every OpenSSH private key body starts with base64("openssh-key-v1\0") = b3BlbnNzaC1rZXktdjEA. The hold looks only for
    // the armor ("PRIVATE KEY-----"), so `sed -n 2,7p ~/.ssh/id_ed25519` (or output cut at both ends) passes the plan and
    // the key body reaches the host.
    const body =
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDx3Q8kq0vH7pS2Yy9w1cJm4n8bT6rLzXkVt0aGfHqQcAAAAJjWk2rX1pNq";
    expect(await heldOrRedacted(`$ sed -n 2,3p ~/.ssh/id_ed25519\n${body}`, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU")).toBe("private-key-held");
  });

  it("an SSH2 (RFC 4716) private key holds the move", async () => {
    // Its armor is "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----" (four dashes and spaces), which "PRIVATE KEY-----" misses.
    const secret = "P2/56wAAAi4AAAA3aWYtbW9kbntzaWdue3JzYS1wa2NzMS1zaGExfSxlbmNyeXB0e3JzYQ";
    const text = `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: "me"\n${secret}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----`;
    expect(await heldOrRedacted(text, secret)).toBe("private-key-held");
  });
});

describe("PR 214 review r3 (LOW): key-named model settings still travel", () => {
  it("a setting named like a token in the shared secret-key list is not carried", () => {
    // settingLooksSecret's name list is anchored and narrower than the shared secretKeys list (secretPatterns.json):
    // access_token, refresh_token, auth_token, client_secret, secret_key and bearer pass it, and a short value under them
    // matches no value pattern, so it reaches the host's disk as it is.
    const session = {
      id: "chat-r3",
      harness: "claude",
      model: "test-model-1",
      modelSettings: { effort: "high", access_token: "abcd1234efgh" },
      title: "t",
      cwd: "/x",
      blocks: [{ id: "u1", role: "user", text: "hi" }],
      queuedMessages: [],
    } as unknown as Session;
    const carried = redactChat(sessionToChat(session)).chat.modelSettings ?? {};
    expect(JSON.stringify(carried)).not.toContain("abcd1234efgh");
  });
});

describe("PR 214 review r3 (MEDIUM): the per-host device key follows the connection, not the host", () => {
  it("the same host reached through a new connection id (removed and added again) is sent the same device key", async () => {
    // deviceKeyFor hashes the desktop's connection id (remote.rs gives a removed-then-added SSH host a fresh uuid). The host
    // keys every moved chat to the device it was sent from, so after a remove and re-add, teleport.read returns null and
    // abort/holds throw "belongs to another device": the Mac can never move that chat back. stableDeviceKey's own comment
    // promises re-pairing does not orphan a moved chat.
    const { sshMoveEndpoint } = await import("./teleportSsh");
    const seen: Record<string, unknown> = {};
    const capture = (conn: string) => async (_method: string, params: Record<string, unknown>) => {
      seen[conn] = params.deviceKey;
      return null;
    };
    await sshMoveEndpoint("connection-before", capture("before"), "env-host-a").read("chat-r3");
    await sshMoveEndpoint("connection-after", capture("after"), "env-host-a").read("chat-r3");
    expect(seen.before).toBeTruthy();
    expect(seen.after).toBe(seen.before);
  });
});
