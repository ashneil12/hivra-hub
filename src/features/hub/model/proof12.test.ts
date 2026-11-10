// @vitest-environment happy-dom
// Point 12: a connector login goes into the Keychain before the row says "On this Mac", and Undo in Bot changes
// really puts a bot's rules file back (the row stays, marked undone). The Keychain and the Mono files are stand-ins
// here; the real Keychain round trip is the Rust test hub_keychain (MONOCODE_KEYCHAIN_PROOF=1).
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

function fakeKeychain() {
  const items = new Map<string, string>();
  let release: (() => void) | null = null;
  const k = {
    items,
    hold: false,
    release: () => release?.(),
    store: vi.fn(async (service: string, account: string, secret: string) => {
      if (k.hold) await new Promise<void>((r) => (release = r));
      items.set(`${service}|${account}`, secret);
    }),
    exists: vi.fn(async (service: string, account: string) => items.has(`${service}|${account}`)),
    remove: vi.fn(async (service: string, account: string) => items.delete(`${service}|${account}`)),
  };
  return k;
}

describe("connector logins live in the Keychain", () => {
  it("signs in through the Keychain, under monocode-hub-test in tests, and keeps only the account name", async () => {
    localStorage.setItem("monocode:hub-keychain-test", "1");
    const c = await import("./connectors");
    const k = fakeKeychain();
    c.setConnectorKeychain(k);
    c.addConnectors([{ id: "github", name: "GitHub", projectId: "hivra" }]);
    await c.signIn("github", { account: "dummy@example.invalid", secret: "not-a-real-secret" });
    expect(k.store).toHaveBeenCalledWith("monocode-hub-test:login:github", "dummy@example.invalid", "not-a-real-secret");
    expect(c.allConnectors()[0]).toMatchObject({ signedIn: true, account: "dummy@example.invalid" });
    expect(localStorage.getItem("monocode:hub-connectors")).not.toContain("not-a-real-secret");
    expect(c.signInState("github")).toBe("on-this-mac");
    await c.signOut("github");
    expect(k.items.size).toBe(0);
    expect(c.allConnectors()[0].signedIn).toBe(false);
  });

  it("a connector id from an imported setup can never name a model key", async () => {
    localStorage.removeItem("monocode:hub-keychain-test");
    const c = await import("./connectors");
    // The model keys are `monocode-hub:model-key`. A connector named like that still lands under `login:`.
    for (const id of ["model-key", "connector:x", "page-source:p"]) {
      expect(c.keychainService(id)).toBe(`monocode-hub:login:${id}`);
      expect(c.keychainService(id)).not.toBe("monocode-hub:model-key");
    }
  });

  it("a Keychain that refuses leaves it signed out with the reason", async () => {
    const c = await import("./connectors");
    c.setConnectorKeychain({ store: async () => { throw "The Keychain didn't save the login."; }, exists: async () => false, remove: async () => false });
    c.addConnectors([{ id: "slack", name: "Slack", projectId: "hivra" }]);
    await c.signIn("slack", { account: "a", secret: "b" });
    expect(c.allConnectors()[0].signedIn).toBe(false);
    expect(c.signInProblem("slack")).toBe("The Keychain didn't save the login.");
  });

  it("the Today Sign in row says Waiting for your Mac… while the Keychain is out, then On this Mac", async () => {
    const mock = await import("./mockData");
    (await import("./hubData")).setHubDataSource(mock.mockHubData);
    const c = await import("./connectors");
    const k = fakeKeychain();
    k.hold = true;
    c.setConnectorKeychain(k);
    c.setConnectorLoginFlow(async () => ({ account: "dummy@example.invalid", secret: "x" }));
    c.addConnectors([{ id: "github", name: "GitHub", projectId: "hivra" }]);
    const { setupItems } = await import("./waiting");
    expect(setupItems()[0]).toMatchObject({ title: "Sign in to GitHub", actionLabel: "Sign in" });
    const p = c.signIn("github");
    await new Promise((r) => setTimeout(r, 0));
    expect(setupItems()[0].signIn).toBe("waiting");
    k.release();
    await p;
    expect(setupItems()[0].signIn).toBe("on-this-mac");
    c.clearLandedSignIns();
    expect(setupItems()).toHaveLength(0);
  });
});

describe("Undo in Bot changes really reverts the bot's rules", () => {
  function fakeFiles(initial: string) {
    const disk = new Map<string, string>([["ed|SOUL.md", initial]]);
    const hash = (t: string) => `h${t.length}:${t}`;
    return {
      disk,
      read: async (m: string, f: string) => ({ text: disk.get(`${m}|${f}`) ?? null, hash: hash(disk.get(`${m}|${f}`) ?? "") }),
      write: async (m: string, f: string, text: string, expected: string) => {
        if (hash(disk.get(`${m}|${f}`) ?? "") !== expected) throw new Error("conflict");
        disk.set(`${m}|${f}`, text);
        return hash(text);
      },
    };
  }
  const before = "# Soul\n\n- Write release notes in 12 steps.\n";
  const after = "# Soul\n\n- Write release notes in 8 steps.\n";

  it("writes the old rules back, keeps the row and marks it undone, and the row survives a restart", async () => {
    const b = await import("./botChanges");
    const f = fakeFiles(after);
    b.setBotFiles(f);
    b.recordBotChange({ id: "rc1", bot: "ed", day: "Today", line: "ed shortened the release-notes skill", now: "12 steps", after: "8 steps", monoId: "ed", file: "SOUL.md", beforeText: before, afterText: after });
    await b.undoBotChange(["rc1"]);
    expect(f.disk.get("ed|SOUL.md")).toBe(before);
    const row = b.botChangeRows().find((r) => r.kind === "one" && r.change.id === "rc1");
    expect(row && row.kind === "one" && row.change.undone).toBe(true);
    expect(b.undoneLine({ now: "12 steps", after: "8 steps" })).toBe("Undone: back to “12 steps”.");
    vi.resetModules();
    const again = await import("./botChanges");
    const kept = again.botChangeRows().find((r) => r.kind === "one" && r.change.id === "rc1");
    expect(kept && kept.kind === "one" && kept.change.undone).toBe(true);
  });

  it("does nothing, and says why, when the bot changed the file again since", async () => {
    const b = await import("./botChanges");
    const f = fakeFiles("# Soul\n\n- Something newer.\n");
    b.setBotFiles(f);
    b.recordBotChange({ id: "rc2", bot: "ed", day: "Today", line: "x", now: "a", after: "b", monoId: "ed", file: "SOUL.md", beforeText: before, afterText: after });
    await b.undoBotChange(["rc2"]);
    expect(f.disk.get("ed|SOUL.md")).toBe("# Soul\n\n- Something newer.\n");
    const row = b.botChangeRows().find((r) => r.kind === "one" && r.change.id === "rc2")!;
    expect(row.kind === "one" && row.change.undone).toBeFalsy();
    expect(row.kind === "one" && row.change.problem).toMatch(/changed this again/);
  });
});

describe("Redo really reapplies an undone change", () => {
  it("writes the change back in and clears undone; refuses if the file moved on", async () => {
    const b = await import("./botChanges");
    const before = "# Soul\n\n- 12 steps\n";
    const after = "# Soul\n\n- 8 steps\n";
    const disk = new Map([["ed|SOUL.md", after]]);
    b.setBotFiles({
      read: async (m, f) => ({ text: disk.get(`${m}|${f}`) ?? null, hash: String(disk.get(`${m}|${f}`)) }),
      write: async (m, f, t, h) => { if (String(disk.get(`${m}|${f}`)) !== h) throw new Error("conflict"); disk.set(`${m}|${f}`, t); return t; },
    });
    b.recordBotChange({ id: "rd1", bot: "ed", day: "Today", line: "x", now: "12 steps", after: "8 steps", monoId: "ed", file: "SOUL.md", beforeText: before, afterText: after });
    await b.undoBotChange(["rd1"]);
    expect(disk.get("ed|SOUL.md")).toBe(before);
    await b.redoBotChange(["rd1"]);
    expect(disk.get("ed|SOUL.md")).toBe(after);
    const row = b.botChangeRows().find((r) => r.kind === "one" && r.change.id === "rd1")!;
    expect(row.kind === "one" && row.change.undone).toBe(false);
    await b.undoBotChange(["rd1"]);
    disk.set("ed|SOUL.md", "# Soul\n\n- something else\n");
    await b.redoBotChange(["rd1"]);
    expect(disk.get("ed|SOUL.md")).toBe("# Soul\n\n- something else\n");
    const kept = b.botChangeRows().find((r) => r.kind === "one" && r.change.id === "rd1")!;
    expect(kept.kind === "one" && kept.change.undone).toBe(true);
    expect(kept.kind === "one" && kept.change.problem).toMatch(/changed since the Undo/);
  });
});
