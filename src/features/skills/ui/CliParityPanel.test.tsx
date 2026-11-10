// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParityReport } from "../model/cliParity";
import { CliParityPanel } from "./CliParityPanel";
import { ProjectCliParity } from "./ProjectCliParity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const report: ParityReport = {
  skills: [
    {
      name: "review",
      path: ".claude/skills/review/SKILL.md",
      scope: "project",
      place: "claude",
      readers: ["claude"],
      sharedFile: false,
    },
    {
      name: "shared",
      path: ".agents/skills/shared/SKILL.md",
      scope: "project",
      place: "agents",
      readers: ["codex", "cursor"],
      sharedFile: true,
    },
  ],
  mcp: [{ cli: "claude", name: "docs", scope: "project", path: ".mcp.json" }],
  rules: [
    { path: "AGENTS.md", readers: ["claude", "codex", "cursor"], pointer: false },
    { path: "CLAUDE.md", readers: ["claude"], pointer: true },
  ],
};

let container: HTMLDivElement;
let root: Root;

function textOf(cli: string): string {
  return container.querySelector(`[data-cli="${cli}"]`)?.textContent ?? "";
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CLI parity panel", () => {
  it("says which CLI will not see a skill, in plain words", async () => {
    await act(async () => {
      root.render(createElement(CliParityPanel, { report, notice: null }));
    });
    expect(container.querySelector("[data-cli-parity]")).not.toBeNull();
    expect(textOf("claude")).toContain("review");
    expect(textOf("claude")).toContain("This will not be visible to Codex or Cursor.");
    expect(textOf("claude")).toContain("docs, in this project");
    expect(textOf("claude")).toContain("CLAUDE.md points at AGENTS.md.");
    expect(textOf("codex")).toContain("shared");
    expect(textOf("codex")).toContain("This will not be visible to Claude Code.");
    expect(textOf("codex")).toContain("None.");
    expect(textOf("cursor")).toContain("shared");
    const body = container.textContent ?? "";
    expect(body).not.toMatch(/[—–]/);
    expect(body).not.toContain("/Users/");
  });

  it("shows None for an empty report and does not treat a miss as the report", async () => {
    await act(async () => {
      root.render(
        createElement(CliParityPanel, {
          report: { skills: [], mcp: [], rules: [] },
          notice: null,
        }),
      );
    });
    expect(container.textContent).toContain("None.");
    await act(async () => {
      root.render(
        createElement(CliParityPanel, {
          report: null,
          notice: "Reading this project timed out. Try again.",
          onRetry: () => {},
        }),
      );
    });
    expect(container.textContent).not.toContain("None.");
    expect(container.querySelector("[data-cli-parity-notice]")?.textContent).toBe(
      "Reading this project timed out. Try again.",
    );
    expect(container.querySelector("button")?.textContent).toBe("Try again");
  });
});

describe("project CLI parity loader", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("shows a timeout as something to try again, then loads on the next try", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "home_dir") return "C:/Users/test";
      if (command === "list_dir") throw new Error("The read timed out");
      return null;
    });
    await act(async () => {
      root.render(createElement(ProjectCliParity, { cwd: "C:/repo" }));
    });
    expect(container.textContent).toContain("Reading this project timed out. Try again.");
    expect(container.textContent).not.toContain("None.");

    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "home_dir") return "C:/Users/test";
      if (command === "list_dir") return [];
      return null;
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Try again");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("None.");
    expect(container.textContent).not.toContain("timed out");
  });

  it("drops a report that arrives after the project changed", async () => {
    const slow = deferred<string>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "home_dir") return "C:/Users/test";
      const path = String((args as { path?: string } | undefined)?.path ?? "");
      if (command === "list_dir") {
        return path.endsWith("/.claude/skills")
          ? [{ name: "only", isDir: true, path, ignored: false }]
          : [];
      }
      if (path.endsWith("/proj/a/.claude/skills/only/SKILL.md")) return slow.promise;
      if (path.endsWith("/proj/b/.claude/skills/only/SKILL.md")) return "---\nname: new-skill\n---\n";
      return null;
    });
    await act(async () => {
      root.render(createElement(ProjectCliParity, { cwd: "C:/proj/a" }));
    });
    await act(async () => {
      root.render(createElement(ProjectCliParity, { cwd: "C:/proj/b" }));
    });
    expect(container.textContent).toContain("new-skill");
    expect(container.textContent).not.toContain("old-skill");
    await act(async () => {
      slow.resolve("---\nname: old-skill\n---\n");
    });
    expect(container.textContent).toContain("new-skill");
    expect(container.textContent).not.toContain("old-skill");
  });
});
