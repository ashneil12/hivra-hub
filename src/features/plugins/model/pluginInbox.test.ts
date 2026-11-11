// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { pluginInboxCards } from "./pluginInbox";
import { PluginApprovals } from "../ui/PluginApprovals";
import type { PendingRequest } from "./pluginInstall";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const agentRequest: PendingRequest = {
  id: "req-1",
  op: "install",
  name: "demo",
  version: "1.2.3",
  source: { kind: "local", path: "/tmp/demo" },
  resolved: { kind: "local", location: "/tmp/demo" },
  requestedBy: { kind: "agent", reason: "It would help with reviews." },
  steps: [{ run: ["npm", "install", "--omit=dev"], cwd: ".", why: "It installs dependencies." }],
  skills: [],
  mcpServers: [],
  reports: [],
  createdAtMs: 2,
};

describe("pluginInboxCards", () => {
  it("shows an agent's ask, its reason and the exact command", () => {
    const [card] = pluginInboxCards([agentRequest]);
    expect(card.title).toBe("Install demo 1.2.3");
    expect(card.body).toContain("An agent asked");
    expect(card.body).toContain("It would help with reviews.");
    expect(card.body).toContain("npm install --omit=dev");
    expect(card.commands).toEqual(["npm install --omit=dev"]);
  });

  it("does not call a person's script approval an agent's ask, and keeps the oldest first", () => {
    const person = {
      ...agentRequest,
      id: "req-0",
      createdAtMs: 1,
      requestedBy: { kind: "person" },
      op: "update",
      replaces: "1.0.0",
    };
    const cards = pluginInboxCards([agentRequest, person]);
    expect(cards.map((card) => card.id)).toEqual(["req-0", "req-1"]);
    expect(cards[0].body).not.toContain("An agent asked");
    expect(cards[0].body).toContain("It would replace 1.0.0.");
    expect(cards[0].title).toBe("Update demo 1.2.3");
  });
});

// WP-101: the install check's findings, in a section of their own on the card.
describe("the install check's section", () => {
  const withScan = (scan?: unknown): PendingRequest => ({
    ...agentRequest,
    scan: scan as PendingRequest["scan"],
  });

  it("names each warning and never the info rows", () => {
    const [card] = pluginInboxCards([
      withScan({
        blocked: false,
        files: 4,
        bytes: 900,
        tokenEstimate: 12,
        findings: [
          { severity: "info", code: "file_count", path: "", message: "It holds 4 files." },
          { severity: "warn", code: "scripts_present", path: "skills/count/scripts/run.py", message: "A script is copied with the plugin; Hivra never runs it." },
          { severity: "warn", code: "credentials_language", path: "", message: "Its instructions talk about keys or credentials." },
        ],
      }),
    ]);
    expect(card.findings).toEqual([
      { path: "skills/count/scripts/run.py", message: "A script is copied with the plugin; Hivra never runs it." },
      { path: "", message: "Its instructions talk about keys or credentials." },
    ]);
    expect(card.scanLine).toBe(
      "The install check found 2 things to know about. None of them stops the install. It is a quick read for known tricks, not a guarantee.",
    );
  });

  it("says so plainly when the check found nothing to flag", () => {
    const [card] = pluginInboxCards([
      withScan({
        blocked: false,
        files: 2,
        bytes: 100,
        tokenEstimate: 3,
        findings: [{ severity: "info", code: "file_count", path: "", message: "It holds 2 files." }],
      }),
    ]);
    expect(card.findings).toEqual([]);
    expect(card.scanLine).toBe("The install check found nothing to flag. It is a quick read for known tricks, not a guarantee.");
  });

  it("treats a request saved by an earlier build, with no scan at all, as nothing to show", () => {
    const [card] = pluginInboxCards([withScan(undefined)]);
    expect(card.findings).toEqual([]);
    expect(card.scanLine).toBe("");
  });

  // WP-101 review M5 (install card): invisible and direction characters are taken out of what a finding shows.
  it("strips invisible and direction characters from a finding's text and path", () => {
    const [card] = pluginInboxCards([
      withScan({
        findings: [{ severity: "warn", code: "x", path: "src/\u202Egpj.js\u200B", message: "Reads\u202E the token\u2066 file" }],
      }),
    ]);
    expect(card.findings).toEqual([{ path: "src/gpj.js", message: "Reads the token file" }]);
  });

  it("ignores a scan that isn't shaped as one, rather than showing junk", () => {
    const [card] = pluginInboxCards([withScan({ findings: "nope" })]);
    expect(card.findings).toEqual([]);
    expect(card.scanLine).toBe("");
    const [odd] = pluginInboxCards([
      withScan({ findings: [null, 7, { severity: "warn", message: 3 }, { severity: "block", message: "x" }] }),
    ]);
    expect(odd.findings).toEqual([]);
  });
});

describe("PluginApprovals", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the agent's ask and declining it calls the command", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugins_pending") return [agentRequest];
      return undefined;
    });
    await act(async () => {
      root.render(createElement(PluginApprovals));
    });
    expect(container.textContent).toContain("An agent asked");
    expect(container.textContent).toContain("npm install --omit=dev");
    const decline = [...container.querySelectorAll("button")].find((button) => button.textContent === "Don't install");
    await act(async () => {
      decline!.click();
    });
    expect(invoke).toHaveBeenCalledWith("plugins_decline", { id: "req-1" });
  });

  it("renders nothing when the waiting list can't be read", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await act(async () => {
      root.render(createElement(PluginApprovals));
    });
    expect(container.textContent).toBe("");
  });

  it("shows the install check's findings beside the plugin, with no section for an old request", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugins_pending")
        return [
          { ...agentRequest, id: "req-2", scan: { blocked: false, files: 3, bytes: 90, tokenEstimate: 5, findings: [
            { severity: "warn", code: "scripts_present", path: "scripts/run.py", message: "A script is copied with the plugin; Hivra never runs it." },
          ] } },
          { ...agentRequest, id: "req-3" },
        ];
      return undefined;
    });
    await act(async () => {
      root.render(createElement(PluginApprovals));
    });
    const sections = container.querySelectorAll("section[aria-label='Install check']");
    expect(sections).toHaveLength(1);
    expect(sections[0].textContent).toContain("scripts/run.py: A script is copied with the plugin; Hivra never runs it.");
    expect(sections[0].textContent).toContain("found 1 thing to know about");
  });
});
