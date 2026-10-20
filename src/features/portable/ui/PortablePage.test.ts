// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  portableInfo: vi.fn(),
  pickExportDestination: vi.fn(),
  exportEverything: vi.fn(),
  pickImportSource: vi.fn(),
  readImport: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("../model/portable", () => bridge);
vi.mock("../../../platform/tauri/fs", () => ({ revealPath: vi.fn() }));

const { PortablePage } = await import("./PortablePage");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  bridge.portableInfo.mockResolvedValue({
    memoryRoot: "/Users/ash/agent-memory",
    dev: false,
    memory: [
      { name: "ash", files: 6, bytes: 20_000, history: true, global: true },
      { name: "hivra", files: 6, bytes: 30_000, history: true, global: false },
    ],
  });
  bridge.pickExportDestination.mockResolvedValue("/Users/ash/Desktop/monocode-hub-export-2026-10-19.tar.gz");
  bridge.exportEverything.mockResolvedValue({
    path: "/Users/ash/Desktop/monocode-hub-export-2026-10-19.tar.gz", form: "archive", files: 40, bytes: 2_500_000,
    counts: { projects: 4, monos: 8, sessions: 120, memoryProjects: 1 }, secretsRemoved: 3, notes: ["The history of ash was left out: an old commit holds something that looks like a secret (API key (sk-))"],
  });
});

async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(PortablePage)));
  return host;
}
const click = async (host: HTMLElement, selector: string) =>
  act(async () => (host.querySelector(selector) as HTMLElement).click());

it("exports with exactly what is ticked: setup always, memory folders and the workspace when asked", async () => {
  const host = await render();
  // Setup can't be unticked; memory and workspace start off.
  expect(host.querySelector("[data-portable-choice=setup] [role=checkbox]")!.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("[data-portable-memory-folders]")).toBeNull();
  await click(host, "[data-portable-choice=memory] [role=checkbox]");
  expect(host.querySelector("[data-portable-memory-folders]")!.textContent).toContain("ash (every project reads it)");
  await click(host, "[data-portable-choice=memory-hivra] [role=checkbox]");
  await click(host, "[data-portable-choice=workspace] [role=checkbox]");
  await click(host, "[data-portable-export]");
  expect(bridge.pickExportDestination).toHaveBeenCalledWith("archive");
  expect(bridge.exportEverything).toHaveBeenCalledWith({
    form: "archive",
    destination: "/Users/ash/Desktop/monocode-hub-export-2026-10-19.tar.gz",
    memory: { projects: ["ash"], history: false, monoMemory: true },
    workspace: true,
  });
  const report = host.querySelector("[data-portable-report]")!.textContent!;
  expect(report).toContain("Saved /Users/ash/Desktop/monocode-hub-export-2026-10-19.tar.gz");
  expect(report).toContain("4 projects, 8 Monos, 1 memory folder, 120 chats");
  expect(report).toContain("3 secrets scrubbed");
  expect(report).toContain("history of ash was left out");
});

it("setup only by default, and nothing happens when the save dialog is cancelled", async () => {
  const host = await render();
  bridge.pickExportDestination.mockResolvedValueOnce(null);
  await click(host, "[data-portable-export]");
  expect(bridge.exportEverything).not.toHaveBeenCalled();
  await click(host, "[data-portable-export]");
  expect(bridge.exportEverything).toHaveBeenCalledWith(expect.objectContaining({ memory: null, workspace: false }));
});

it("when this copy's memory can't be read, the page says so instead of showing none", async () => {
  bridge.portableInfo.mockRejectedValue(new Error("The memory folder couldn't be read: permission denied"));
  const host = await render();
  expect(host.querySelector("[data-portable-problem]")?.textContent).toContain("permission denied");
});

it("a failed read says why in plain words and changes nothing", async () => {
  bridge.pickImportSource.mockResolvedValue("/tmp/newer.tar.gz");
  bridge.readImport.mockRejectedValue(new Error("This export was made by a newer MonoCode Hub (format 3; this build reads up to 2). Update the app first."));
  const host = await render();
  await click(host, "[data-portable-import-file]");
  expect(host.querySelector("[data-portable-problem]")!.textContent).toContain("newer MonoCode Hub");
  expect(bridge.restore).not.toHaveBeenCalled();
});
