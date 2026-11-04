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
});
