import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));

import {
  beginSave,
  deleteSecret,
  listSecrets,
  removeEnv,
  renameSecret,
  revealSecret,
  revokeGrant,
  rotateSecret,
  saveNew,
  saveRequest,
  copyNotes,
  scopeLabel,
  slugIsValid,
  slugOf,
  writeEnv,
} from "./secrets";

const VALUE = "sk_live_51NxAbCdEfGhIjKl";

describe("the slug a card shows", () => {
  it("lower-cases and turns spaces and underscores into dashes", () => {
    expect(slugOf("Stripe API Key")).toBe("stripe-api-key");
    expect(slugOf("my_key")).toBe("my-key");
    expect(slugOf("  padded  ")).toBe("padded");
  });

  it("refuses what the vault refuses, before anything is sent", () => {
    for (const bad of ["", "   ", "a..b", "with/slash", "café", "-dash", "dash-", "x".repeat(65)]) {
      expect(slugIsValid(bad), bad).toBe(false);
    }
    expect(slugIsValid("stripe-api-key")).toBe(true);
    expect(slugIsValid("a")).toBe(true);
    expect(slugIsValid("x".repeat(64))).toBe(true);
  });
});

describe("every call names the vault command and moves handles", () => {
  it("uses the hub plugin for each", async () => {
    await listSecrets();
    await saveNew("global", "stripe-api-key", "Stripe", VALUE);
    await beginSave("req-1");
    await saveRequest("req-1", "tok", null, VALUE);
    await renameSecret("global", "stripe-api-key", "Stripe live", 2);
    await rotateSecret("global", "stripe-api-key", null, VALUE);
    await revokeGrant("global", "stripe-api-key", "mono", "mono-1", "stripe");
    await deleteSecret("global", "stripe-api-key");
    await writeEnv("/p", "/p", "global", "stripe-api-key", "STRIPE_API_KEY");
    await removeEnv({ project: "/p", worktree: "/p", scope: "global", name: "stripe-api-key", envName: "STRIPE_API_KEY" });
    expect(invoke.mock.calls.every(([cmd]) => String(cmd).startsWith("plugin:hub|secrets_"))).toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, "plugin:hub|secrets_list", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin:hub|secrets_save_new", {
      scope: "global",
      name: "stripe-api-key",
      label: "Stripe",
      value: VALUE,
    });
    expect(invoke).toHaveBeenCalledWith("plugin:hub|secrets_begin_save", { id: "req-1" });
  });
});

describe("only reveal brings a value back", () => {
  it("is the one call whose answer holds the value", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:hub|secrets_reveal") return VALUE;
      if (cmd === "plugin:hub|secrets_list") {
        return [{ scope: "global", name: "stripe-api-key", label: "Stripe", last4: "iKl", createdAt: 1, updatedAt: 1, lastUsedAt: null, version: 1, approved: [], executables: [], envFiles: [], needsValue: false }];
      }
      if (cmd === "plugin:hub|secrets_rotate") return { secret: { last4: "iKl" }, updated: [], leftAlone: [] };
      return null;
    });
    const list = await listSecrets();
    expect(JSON.stringify(list)).not.toContain(VALUE);
    const report = await rotateSecret("global", "stripe-api-key", null, VALUE);
    expect(JSON.stringify(report)).not.toContain(VALUE);
    expect(await revealSecret("global", "stripe-api-key")).toBe(VALUE);
  });

  it("never writes to localStorage or sessionStorage", async () => {
    const local = new Map<string, string>();
    const session = new Map<string, string>();
    const spy = (map: Map<string, string>) => {
      const set = vi.fn((key: string, value: string) => void map.set(key, value));
      return { setItem: set };
    };
    const localSpy = spy(local);
    const sessionSpy = spy(session);
    vi.stubGlobal("localStorage", { ...localSpy, getItem: () => null, removeItem: () => {} });
    vi.stubGlobal("sessionStorage", { ...sessionSpy, getItem: () => null, removeItem: () => {} });
    invoke.mockImplementation(async (cmd: string) => (cmd === "plugin:hub|secrets_reveal" ? VALUE : null));
    await revealSecret("global", "stripe-api-key");
    await saveNew("global", "stripe-api-key", null, VALUE);
    expect(localSpy.setItem).not.toHaveBeenCalled();
    expect(sessionSpy.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
describe("where a key lives, in plain words", () => {
  it("is Everywhere or Project: <folder name>", () => {
    expect(scopeLabel("global")).toBe("Everywhere");
    expect(scopeLabel("project./Users/person/Projects/hivra")).toBe("Project: hivra");
    expect(scopeLabel("project.C:\\work\\hivra")).toBe("Project: hivra");
  });

  it("says which copy is used when a name is saved both ways", () => {
    const row = (scope: string, name: string) => ({ scope, name }) as never;
    const notes = copyNotes([
      row("global", "stripe-api-key"),
      row("project./work/hivra", "stripe-api-key"),
      row("global", "resend-key"),
      row("project./work/other", "github-token"),
    ]);
    expect(notes.get("project./work/hivra\u0000stripe-api-key")).toBe(
      "This project's copy is used; there is also one for everywhere.",
    );
    expect(notes.get("global\u0000stripe-api-key")).toBe(
      "Projects that have their own copy of this name use that one instead.",
    );
    // A name saved one way only says nothing.
    expect(notes.has("global\u0000resend-key")).toBe(false);
    expect(notes.has("project./work/other\u0000github-token")).toBe(false);
  });
});
