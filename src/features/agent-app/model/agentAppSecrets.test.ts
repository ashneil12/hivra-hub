// @vitest-environment happy-dom
// WP-92: the vault's app actions (agentAppSecrets.ts). The vault itself is mocked: these tests hold the identity the
// handler passes (chat, Mono, project), the words the model is told, and that no result carries a value.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import type { SecretRow } from "../../secrets/model/secrets";
import { handleAgentApp, type AgentAppHost } from "./agentApp";

const api = vi.hoisted(() => ({
  listSecrets: vi.fn(),
  requestSecret: vi.fn(),
  grantFor: vi.fn(),
}));
vi.mock("../../secrets/model/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../secrets/model/secrets")>();
  return { ...actual, ...api };
});
vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));

const VALUE = "sk_live_51NxAbCdEfGhIjKlMnOp";

beforeEach(() => {
  vi.clearAllMocks();
});

function row(over: Partial<SecretRow> = {}): SecretRow {
  return {
    scope: "global",
    name: "stripe-api-key",
    label: "Stripe API key",
    last4: "MnOp",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastUsedAt: null,
    version: 1,
    approved: ["Hivra lead"],
    executables: ["stripe"],
    envFiles: [],
    needsValue: false,
    ...over,
  };
}

function projectChat(): Session {
  return { ...newSession("claude", "/code/tally", "claude:opus-5-5"), id: "chat-1" };
}

function monoChat(): Session {
  return { ...newSession("claude", "/Users/person/monos/hivra-lead", "claude:opus-5-5"), id: "mono-chat" };
}

function hostFor(who: "project" | "mono"): AgentAppHost {
  return {
    isMono: (id) => who === "mono" && id === "mono-chat",
    monoOf: (id) =>
      who === "mono" && id === "mono-chat"
        ? { id: "hivra-lead", name: "Hivra lead", projects: ["/code/tally"] }
        : undefined,
    ownerMonoOf: () => undefined,
    codingTeamOf: () => undefined,
  } as unknown as AgentAppHost;
}

describe("secrets.request", () => {
  it("asks in the chat's project, shows the waiting state, and tells the model to end its turn", async () => {
    api.requestSecret.mockResolvedValue({
      secret: null,
      request: { id: "req-1", chat: "chat-1", mono: null, project: "/code/tally", scope: "project./code/tally", name: "stripe-api-key", why: "to list customers", state: "open", createdAt: 0, updatedAt: 0 },
    });
    const out = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.request",
      { name: "Stripe API key", why: "to list customers" },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(api.requestSecret).toHaveBeenCalledWith({
      chat: "chat-1",
      project: "/code/tally",
      name: "Stripe API key",
      why: "to list customers",
    });
    expect(out).toMatchObject({ requestId: "req-1", state: "waiting", name: "stripe-api-key" });
    expect(out.note).toMatch(/end your turn/);
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it("asks globally from a Mono's own chat, naming the Mono", async () => {
    api.requestSecret.mockResolvedValue({
      secret: null,
      request: { id: "req-2", chat: "mono-chat", mono: "hivra-lead", project: null, scope: "global", name: "stripe-api-key", why: "for the invoices", state: "open", createdAt: 0, updatedAt: 0 },
    });
    await handleAgentApp(
      monoChat(),
      "r1",
      "secrets.request",
      { name: "stripe-api-key", why: "for the invoices" },
      hostFor("mono"),
    );
    expect(api.requestSecret).toHaveBeenCalledWith({
      chat: "mono-chat",
      mono: "hivra-lead",
      name: "stripe-api-key",
      why: "for the invoices",
    });
  });

  it("returns the handle instead of a card when the name already resolves", async () => {
    api.requestSecret.mockResolvedValue({ secret: row(), request: null });
    const out = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.request",
      { name: "stripe-api-key", why: "to list customers" },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ state: "found", name: "stripe-api-key", scope: "global", last4: "MnOp" });
    expect(out).not.toHaveProperty("requestId");
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it("refuses an empty why before the vault is called", async () => {
    await expect(
      handleAgentApp(projectChat(), "r1", "secrets.request", { name: "k", why: "  " }, hostFor("project")),
    ).rejects.toThrow(/why/);
    expect(api.requestSecret).not.toHaveBeenCalled();
  });
});

describe("secrets.run", () => {
  it("passes the argv and environment through, and hands back the run's result, never a grant", async () => {
    api.grantFor.mockResolvedValue({
      state: "ran",
      name: "stripe-api-key",
      env: "STRIPE_API_KEY",
      exitCode: 0,
      stdout: "3 customers",
      stderr: "",
      timedOut: false,
      truncated: false,
      outputUnread: false,
    });
    const out = await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"], timeoutSeconds: 30 },
      hostFor("project"),
    );
    expect(api.grantFor).toHaveBeenCalledWith({
      chat: "chat-1",
      project: "/code/tally",
      name: "stripe-api-key",
      env: "STRIPE_API_KEY",
      command: ["stripe", "customers", "list"],
      timeoutSeconds: 30,
    });
    expect(out).toMatchObject({ state: "ran", stdout: "3 customers", exitCode: 0 });
    expect(out).not.toHaveProperty("grant");
  });

  it("says waiting for the person and missing means ask, each with plain words", async () => {
    api.grantFor.mockResolvedValueOnce({ state: "waiting", decisionKey: "secret/stripe", name: "stripe-api-key", scope: "global" });
    const waiting = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"] },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(waiting.state).toBe("waiting");
    expect(waiting.note).toMatch(/end your turn/);
    expect(waiting.note).toMatch(/hasn't approved/);

    api.grantFor.mockResolvedValueOnce({ state: "missing", name: "stripe-api-key", scope: "global" });
    const missing = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"] },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(missing.note).toMatch(/secrets_request/);

    api.grantFor.mockResolvedValueOnce({ state: "denied", decisionKey: "secret/stripe", name: "stripe-api-key" });
    const denied = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"] },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(denied.note).toMatch(/said no/);
  });

  it("refuses a shell line, a bad env name, a value field and a bad timeout before the vault is called", async () => {
    const base = { name: "k", env: "K", command: ["stripe"] };
    await expect(handleAgentApp(projectChat(), "r", "secrets.run", { ...base, command: "stripe customers list" }, hostFor("project"))).rejects.toThrow(/one list element/);
    await expect(handleAgentApp(projectChat(), "r", "secrets.run", { ...base, env: "stripe key" }, hostFor("project"))).rejects.toThrow(/capital letters/);
    await expect(handleAgentApp(projectChat(), "r", "secrets.run", { ...base, value: VALUE }, hostFor("project"))).rejects.toThrow(/Unknown secrets.run fields: value/);
    await expect(handleAgentApp(projectChat(), "r", "secrets.run", { ...base, timeoutSeconds: 0 }, hostFor("project"))).rejects.toThrow(/timeoutSeconds/);
    expect(api.grantFor).not.toHaveBeenCalled();
  });
});

describe("secrets.list", () => {
  it("shows handles for the chat's project and the global ones only, and no value", async () => {
    api.listSecrets.mockResolvedValue([
      row(),
      row({ scope: "project./code/tally", name: "tally-token", label: "Tally token" }),
      row({ scope: "project./code/other", name: "other-token", label: "Other token" }),
    ]);
    const out = (await handleAgentApp(projectChat(), "r1", "secrets.list", {}, hostFor("project"))) as {
      secrets: { name: string }[];
    };
    expect(out.secrets.map((secret) => secret.name)).toEqual(["stripe-api-key", "tally-token"]);
    expect(JSON.stringify(out)).not.toContain(VALUE);
  });

  it("says how to ask when the vault is empty", async () => {
    api.listSecrets.mockResolvedValue([]);
    const out = (await handleAgentApp(projectChat(), "r1", "secrets.list", {}, hostFor("project"))) as { note: string };
    expect(out.note).toMatch(/secrets_request/);
  });
});

describe("secrets.run answers with the result, never a grant (fix round 2, C1)", () => {
  it("drops a grant even if one reached the handler, and carries no value", async () => {
    api.grantFor.mockResolvedValueOnce({
      state: "granted",
      grant: "eyJwYXlsb2FkIjoieCJ9.c2ln",
      scope: "global",
      name: "stripe-api-key",
      version: 1,
      env: "STRIPE_API_KEY",
      timeoutSeconds: 30,
    });
    const out = (await handleAgentApp(
      projectChat(),
      "r1",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"] },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(out.grant).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("eyJ");
  });

  it("passes the scrubbed answer of a run through unchanged", async () => {
    api.grantFor.mockResolvedValueOnce({
      state: "ran",
      name: "stripe-api-key",
      env: "STRIPE_API_KEY",
      exitCode: 0,
      stdout: "2 customers",
      stderr: "",
      timedOut: false,
      truncated: false,
      outputUnread: false,
    });
    const out = (await handleAgentApp(
      projectChat(),
      "r2",
      "secrets.run",
      { name: "stripe-api-key", env: "STRIPE_API_KEY", command: ["stripe", "customers", "list"] },
      hostFor("project"),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ state: "ran", stdout: "2 customers", exitCode: 0 });
  });
});
