import { describe, expect, it, vi } from "vitest";
import {
  assembleHealth,
  configuredEndpoint,
  factsFrom,
  HEALTH_REFRESH_MS,
  healthLine,
  healthRows,
  LOW_DISK_BYTES,
  readCliHealth,
  type HealthFacts,
} from "./health";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function facts(extra: Partial<HealthFacts> = {}): HealthFacts {
  return {
    clis: [],
    git: { state: "ok", version: "git version 2.39.2" },
    diskFreeBytes: LOW_DISK_BYTES,
    database: "ok",
    dataWritable: true,
    plugins: "readable",
    lastBackupAt: null,
    now: NOW,
    gateway: null,
    ...extra,
  };
}

function text(extra: Partial<HealthFacts> = {}): string[] {
  return healthRows(facts(extra)).map(healthLine);
}

describe("health rows", () => {
  it("refreshes every 15 minutes", () => {
    expect(HEALTH_REFRESH_MS).toBe(15 * 60 * 1000);
  });

  it("says when a CLI is missing, signed in, not signed in, or has no sign-in check", () => {
    const lines = text({
      clis: [
        { id: "claude", name: "Claude Code", installed: false, signedIn: null },
        { id: "codex", name: "Codex", installed: true, signedIn: false },
        { id: "cursor", name: "Cursor", installed: true, signedIn: null },
        { id: "grok", name: "Grok Build", installed: true, signedIn: true },
      ],
    });
    expect(lines[0]).toBe("Problem. Claude Code is not installed. Install it, then open Hivra again.");
    expect(lines[1]).toBe("Check this. Codex is installed but not signed in. Sign in from Providers.");
    expect(lines[2]).toBe("OK. Cursor is installed.");
    expect(lines[3]).toBe("OK. Grok Build is installed and signed in.");
  });

  it("does not call a miss a failure when the probe did not finish", () => {
    expect(text({ clis: [{ id: "claude", name: "Claude Code", installed: null, signedIn: false }] })).toContain(
      "Check this. Couldn't check whether Claude Code is installed. It will be checked again shortly.",
    );
  });

  it("keeps the first row when a CLI is listed twice, and skips a blank id", () => {
    const rows = healthRows(
      facts({
        clis: [
          { id: "claude", name: "Claude Code", installed: true, signedIn: true },
          { id: "claude", name: "Other", installed: false, signedIn: null },
          { id: "", name: "Nope", installed: false, signedIn: null },
        ],
      }),
    );
    expect(rows.filter((row) => row.id.startsWith("cli:"))).toEqual([
      { id: "cli:claude", tone: "ok", text: "Claude Code is installed and signed in." },
    ]);
  });

  it("flattens a CLI name and does not invent one", () => {
    expect(text({ clis: [{ id: "pi", name: "Pi\nagent", installed: true, signedIn: null }] })[0]).toBe(
      "OK. Pi agent is installed.",
    );
    expect(text({ clis: [{ id: "pi", name: "   ", installed: false, signedIn: null }] })[0]).toContain(
      "This CLI is not installed.",
    );
  });

  it("reports git, and only echoes a version that looks like one", () => {
    expect(text()).toContain("OK. Git is installed (git version 2.39.2).");
    expect(text({ git: { state: "ok", version: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } })).toContain(
      "OK. Git is installed.",
    );
    expect(text({ git: { state: "ok", version: null } })).toContain("OK. Git is installed.");
    expect(text({ git: { state: "missing" } })).toContain(
      "Problem. Git is not installed. Install Git, then open Hivra again.",
    );
    expect(text({ git: { state: "unread" } })).toContain(
      "Check this. Couldn't check Git this time. It will be checked again shortly.",
    );
  });

  it("warns under 2 GB and treats a missing reading as not final", () => {
    expect(text({ diskFreeBytes: LOW_DISK_BYTES })).toContain("OK. There is enough free disk space.");
    expect(text({ diskFreeBytes: LOW_DISK_BYTES - 1 })).toContain(
      "Check this. Less than 2 GB is free. Free some space before a long run.",
    );
    expect(text({ diskFreeBytes: 0 })).toContain("Check this. Less than 2 GB is free. Free some space before a long run.");
    expect(text({ diskFreeBytes: null })).toContain(
      "Check this. Couldn't read free disk space. It will be checked again shortly.",
    );
  });

  it("separates a database that failed from one that could not be read", () => {
    expect(text()).toContain("OK. The app database looks fine.");
    expect(text({ database: "problem" })).toContain(
      "Problem. The app database failed its check. Copy diagnostics before you keep working.",
    );
    expect(text({ database: "unread" })).toContain(
      "Check this. Couldn't check the app database this time. It will be checked again shortly.",
    );
  });

  it("reports the data folder and the plugins folder", () => {
    expect(text({ dataWritable: false })).toContain(
      "Problem. The data folder cannot be written. Check that Hivra can save files.",
    );
    expect(text({ dataWritable: null })).toContain(
      "Check this. Couldn't check the data folder this time. It will be checked again shortly.",
    );
    expect(text({ plugins: "missing" })).toContain("OK. No plugins folder yet.");
    expect(text({ plugins: "unreadable" })).toContain(
      "Problem. The plugins folder cannot be read. Check its permissions.",
    );
    expect(text({ plugins: "unread" })).toContain(
      "Check this. Couldn't check the plugins folder this time. It will be checked again shortly.",
    );
  });

  it("gives the backup age in plain words, and omits the row when there is no backup", () => {
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    expect(text()).not.toContain(expect.stringContaining("backup"));
    expect(text({ lastBackupAt: NOW - 30_000 })).toContain("OK. Last backup was just now.");
    expect(text({ lastBackupAt: NOW - minute })).toContain("OK. Last backup was 1 minute ago.");
    expect(text({ lastBackupAt: NOW - 5 * minute })).toContain("OK. Last backup was 5 minutes ago.");
    expect(text({ lastBackupAt: NOW - hour })).toContain("OK. Last backup was 1 hour ago.");
    expect(text({ lastBackupAt: NOW - 3 * hour })).toContain("OK. Last backup was 3 hours ago.");
    expect(text({ lastBackupAt: NOW - day })).toContain("OK. Last backup was 1 day ago.");
    expect(text({ lastBackupAt: NOW - 9 * day })).toContain("OK. Last backup was 9 days ago.");
    expect(text({ lastBackupAt: NOW + minute })).toContain(
      "Check this. The last backup time is ahead of this Mac. Check the clock.",
    );
  });

  it("checks a configured endpoint, and a miss is not a final failure", () => {
    expect(text()).not.toContain(expect.stringContaining("answered"));
    expect(text({ gateway: { name: "Ollama", state: "answered" } })).toContain("OK. Ollama answered.");
    const down = text({ gateway: { name: "Ollama", state: "down" } });
    expect(down).toContain("Check this. Couldn't reach Ollama this time. It will be checked again shortly.");
    expect(down.join("\n")).not.toContain("Problem.");
    const slow = text({ gateway: { name: "Ollama\nlocal", state: "timedOut" } });
    expect(slow).toContain("Check this. Ollama local did not answer in time. It will be checked again shortly.");
    expect(slow.join("\n")).not.toContain("Problem.");
    expect(text({ gateway: { name: "  ", state: "refused" } })).toContain(
      "Check this. That endpoint does not have an address Hivra can check.",
    );
  });

  it("puts the rows in a fixed order", () => {
    const ids = healthRows(
      facts({
        clis: [{ id: "claude", name: "Claude Code", installed: true, signedIn: true }],
        lastBackupAt: NOW,
        gateway: { name: "Ollama", state: "answered" },
      }),
    ).map((row) => row.id);
    expect(ids).toEqual(["cli:claude", "git", "disk", "database", "data", "plugins", "backup", "gateway"]);
  });
});

describe("configured endpoint", () => {
  it("is quiet when nothing is configured, and skips a blank address", () => {
    expect(configuredEndpoint([])).toBeNull();
    expect(configuredEndpoint([{ name: "Local", baseUrl: "  " }, { name: "Ollama", baseUrl: "http://localhost:11434" }])).toEqual({
      name: "Ollama",
      url: "http://localhost:11434",
    });
  });

  it("flattens the name", () => {
    expect(configuredEndpoint([{ name: "My\nmodel", baseUrl: "http://127.0.0.1:9" }])).toEqual({
      name: "My model",
      url: "http://127.0.0.1:9",
    });
  });
});

describe("cli facts", () => {
  it("reads sign-in only for an installed CLI this app already checks", async () => {
    const identity = vi.fn(async (id: string) => (id === "claude" ? { email: "a@b.c" } : null));
    const rows = await readCliHealth(
      [
        { id: "claude", name: "Claude Code" },
        { id: "codex", name: "Codex" },
        { id: "cursor", name: "Cursor" },
        { id: "grok", name: "Grok Build" },
      ],
      {
        installed: (id) => id !== "grok",
        identity,
      },
    );
    expect(identity.mock.calls.map((call) => call[0])).toEqual(["claude", "codex"]);
    expect(rows.map((row) => [row.id, row.installed, row.signedIn])).toEqual([
      ["claude", true, true],
      ["codex", true, false],
      ["cursor", true, null],
      ["grok", false, null],
    ]);
  });

  it("treats a sign-in read that throws as unknown, not signed out", async () => {
    const rows = await readCliHealth([{ id: "claude", name: "Claude Code" }], {
      installed: () => true,
      identity: async () => {
        throw new Error("busy");
      },
    });
    expect(rows[0]?.signedIn).toBeNull();
  });

  it("drops a duplicate and a blank id", async () => {
    const identity = vi.fn(async () => ({ email: "a@b.c" }));
    const rows = await readCliHealth(
      [
        { id: "claude", name: "Claude Code" },
        { id: "claude", name: "Again" },
        { id: "", name: "Nope" },
      ],
      { installed: () => true, identity },
    );
    expect(rows).toHaveLength(1);
    expect(identity).toHaveBeenCalledTimes(1);
  });
});

describe("assembling a pass", () => {
  it("does not ask for a gateway when none is configured", async () => {
    const machine = vi.fn(async () => ({ git: { state: "ok", version: "git version 2.39.2" } }));
    const built = await assembleHealth({
      clis: async () => [],
      endpoint: () => null,
      machine,
      now: () => NOW,
    });
    expect(machine).toHaveBeenCalledWith(null);
    expect(built.gateway).toBeNull();
  });

  it("sends the configured address once", async () => {
    const machine = vi.fn(async () => ({ gateway: { state: "answered" } }));
    const built = await assembleHealth({
      clis: async () => [],
      endpoint: () => ({ name: "Ollama", url: "http://127.0.0.1:11434" }),
      machine,
      now: () => NOW,
    });
    expect(machine).toHaveBeenCalledTimes(1);
    expect(machine).toHaveBeenCalledWith("http://127.0.0.1:11434");
    expect(built.gateway).toEqual({ name: "Ollama", state: "answered" });
  });

  it("keeps going when a port throws", async () => {
    const built = await assembleHealth({
      clis: async () => {
        throw new Error("probe");
      },
      endpoint: () => ({ name: "Ollama", url: "http://127.0.0.1:9" }),
      machine: async () => {
        throw new Error("down");
      },
      now: () => NOW,
    });
    expect(built.clis).toEqual([]);
    expect(built.git.state).toBe("unread");
    expect(built.database).toBe("unread");
    expect(built.gateway).toEqual({ name: "Ollama", state: "down" });
  });

  it("does not trust an odd payload", () => {
    const built = factsFrom(
      { diskFreeBytes: "lots", database: "fine", dataWritable: "yes", plugins: "yes", lastBackupAt: 0 },
      { clis: [], gatewayName: null, now: NOW },
    );
    expect(built.diskFreeBytes).toBeNull();
    expect(built.database).toBe("unread");
    expect(built.dataWritable).toBeNull();
    expect(built.plugins).toBe("unread");
    expect(built.lastBackupAt).toBeNull();
    expect(healthRows(built).some((row) => row.tone === "ok" && row.id !== "plugins")).toBe(false);
  });
});
