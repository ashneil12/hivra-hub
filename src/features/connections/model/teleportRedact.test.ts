import { describe, expect, it } from "vitest";
import { planMove, redactChat, type ChatSnapshot } from "./teleport";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

// Each form the security review lists, with the fragment that must never reach the moved copy.
const FORMS: Array<[string, string, string]> = [
  ["JSON api_key", '{"api_key":"abcd1234efgh5678ijkl"}', "abcd1234efgh5678ijkl"],
  ["OPENAI_API_KEY assignment", 'export OPENAI_API_KEY="abcdef0123456789abcdef"', "abcdef0123456789abcdef"],
  ["AWS access key", "key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"],
  ["AWS secret assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI0K7MDENG", "wJalrXUtnFEMI0K7MDENG"],
  ["GitHub classic token", "ghp_" + "a".repeat(36), "ghp_" + "a".repeat(36)],
  ["GitHub fine-grained token", "github_pat_" + "A1".repeat(25), "github_pat_" + "A1".repeat(25)],
  ["Slack bot token", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
  ["Google API key", "AIza" + "B".repeat(35), "AIza" + "B".repeat(35)],
  ["JSON web token", JWT, JWT],
  ["Postgres URL password", "postgres://user:hunter2pass@db.example.com/app", "hunter2pass"],
  ["password value", "password: correct-horse-battery", "correct-horse-battery"],
];

function chat(over: Partial<ChatSnapshot>): ChatSnapshot {
  return {
    chatId: "chat-r",
    provider: "claude",
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    model: "test-model-1",
    effort: "high",
    title: "Plain title",
    transcript: JSON.stringify([{ id: "b1", role: "user", text: "hello" }]),
    queued: [],
    turnRunning: false,
    approvalPending: false,
    ...over,
  };
}

describe("WP-177 redaction before a move (shared secret list)", () => {
  it.each(FORMS)("%s is redacted from the transcript and counted in the plan", async (_label, text, fragment) => {
    const c = chat({ transcript: JSON.stringify([{ id: "b1", role: "assistant", text }]) });
    const out = redactChat(c);
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.chat.transcript).not.toContain(fragment);
    const planned = await planMove(c, "this-mac", "host-a");
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(planned.plan.redactions).toBeGreaterThan(0);
  });

  it("redacts a key-shaped value under a secret field name in the parsed transcript", () => {
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b1", role: "user", text: "x", api_key: "abcd1234efgh5678ijkl" }]) }));
    expect(out.chat.transcript).not.toContain("abcd1234efgh5678ijkl");
  });

  it("redacts a secret written inside a JSON-escaped string too", () => {
    const text = '{\\"password\\":\\"letters-only-secret\\"}';
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b1", role: "assistant", text }]) }));
    expect(out.chat.transcript).not.toContain("letters-only-secret");
  });

  it("redacts the title and each queued message too", async () => {
    const out = redactChat(
      chat({ title: "deploy with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX", queued: ["then ghp_" + "b".repeat(36)] }),
    );
    expect(out.chat.title).not.toContain("sk-ant-api03");
    expect(out.chat.queued[0]).not.toContain("ghp_" + "b".repeat(36));
    expect(out.redactions).toBeGreaterThanOrEqual(2);
  });

  it("a letters-only password is redacted once, not twice", () => {
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "user", text: "password=correcthorse" }]) }));
    expect(out.chat.transcript).not.toContain("correcthorse");
    expect(out.chat.transcript).not.toContain("[secret removed] removed]");
    expect(out.redactions).toBe(1);
  });

  it.each([
    ["DB_PASS", "DB_PASS=s3cret-value", "s3cret-value"],
    ["ENCRYPTION_KEY", "ENCRYPTION_KEY=letters-only-key", "letters-only-key"],
    ["JWT_SIGNING_KEY", "JWT_SIGNING_KEY=signing-key-value", "signing-key-value"],
    ["cookie session", "Cookie: session=abc123session", "abc123session"],
    ["netrc password", "machine example.com\npassword hunter2netrc", "hunter2netrc"],
    ["authorization token", "Authorization: token deadbeefcafebabe", "deadbeefcafebabe"],
    ["mysql password", "mysql -phunter2sql -h db", "hunter2sql"],
  ])("%s is redacted", (_label, text, fragment) => {
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text }]) }));
    expect(out.chat.transcript).not.toContain(fragment);
    expect(out.redactions).toBeGreaterThan(0);
  });

  it("an AWS secret in a comma-separated row is redacted", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text: `name,aws_secret_access_key,${secret}` }]) }));
    expect(out.chat.transcript).not.toContain(secret);
    expect(out.redactions).toBeGreaterThan(0);
  });

  it("OPENAI_KEY= is redacted", () => {
    const secret = "plainopenai";
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text: `OPENAI_KEY=${secret}` }]) }));
    expect(out.chat.transcript).not.toContain(secret);
  });

  it("a Discord user token is redacted", () => {
    const secret = `${"N".repeat(24)}.${"a".repeat(6)}.${"b".repeat(27)}`;
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "user", text: `token ${secret} here` }]) }));
    expect(out.chat.transcript).not.toContain(secret);
  });

  it("a held move names the message and does not print the key", async () => {
    const secret = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";
    const planned = await planMove(
      chat({
        transcript: JSON.stringify([
          { id: "u1", role: "user", text: "show the key" },
          { id: "t1", role: "tool", text: "", tool: { title: "Bash", detail: secret } },
        ]),
      }),
      "this-mac",
      "host-a",
    );
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.refusal.reason).toBe("private-key-held");
      expect(planned.refusal.message).toContain("t1");
      expect(planned.refusal.message).not.toContain(secret);
    }
  });

  it("a plan with nothing secret reports zero redactions", async () => {
    const planned = await planMove(chat({}), "this-mac", "host-a");
    if (!planned.ok) throw new Error("plan");
    expect(planned.plan.redactions).toBe(0);
  });
});

describe("WP-177 ids and the plan", () => {
  it("refuses a provider session id that is not an id", async () => {
    const planned = await planMove(chat({ providerSessionId: "../../etc/x" }), "this-mac", "host-a");
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("invalid-session-id");
  });

  it("shows the queued messages in the plan, so the person sees what travels", async () => {
    const planned = await planMove(chat({ queued: ["ship it after the tests"] }), "this-mac", "host-a");
    if (!planned.ok) throw new Error("plan");
    expect(planned.plan.queued).toEqual(["ship it after the tests"]);
  });
});

describe("WP-177 MEDIUM F: the remaining forms", () => {
  const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
  const b64Key = Buffer.from(PEM).toString("base64");

  it("Authorization: Basic is redacted", () => {
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "user", text: "Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3M=" }]) }));
    expect(out.chat.transcript).not.toContain("dXNlcjpzdXBlcnNlY3JldHBhc3M=");
  });

  it("a private key with no END line (truncated output) is redacted to the end of the string", () => {
    const truncated = "here it is -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAtruncatedkeymaterialhere";
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text: truncated }]) }));
    expect(out.chat.transcript).not.toContain("truncatedkeymaterialhere");
  });

  it("a base64-encoded key is redacted", () => {
    const out = redactChat(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text: `key: ${b64Key}` }]) }));
    expect(out.chat.transcript).not.toContain(b64Key.slice(0, 40));
  });

  it("a key split across two blocks is refused: the move names the private key and does not travel", async () => {
    const [first, second] = [PEM.slice(0, 30), PEM.slice(30)];
    const c = chat({
      transcript: JSON.stringify([
        { id: "b1", role: "assistant", text: first },
        { id: "b2", role: "assistant", text: second },
      ]),
    });
    const planned = await planMove(c, "this-mac", "host-a");
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("private-key-held");
  });

  it("a whole private key in one block is also refused, not only redacted", async () => {
    const planned = await planMove(chat({ transcript: JSON.stringify([{ id: "b", role: "assistant", text: PEM }]) }), "this-mac", "host-a");
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("private-key-held");
  });
});
