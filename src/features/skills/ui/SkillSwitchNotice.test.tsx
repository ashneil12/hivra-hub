// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SKILL_SWITCH_CHECKING,
  SkillSwitchNotice,
  skillSwitchPairs,
} from "./SkillSwitchNotice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Mode = "claude-only" | "both" | "timeout" | "hang";

const state = {
  mode: "claude-only" as Mode,
  hang: null as Promise<string> | null,
  paths: [] as string[],
};

let container: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function skillDir(path: string) {
  return [{ name: "review-only", isDir: true, path, ignored: false }];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.mode = "claude-only";
  state.hang = null;
  state.paths = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "home_dir") return "C:/Users/test";
    const path = String((args as { path?: string } | undefined)?.path ?? "");
    if (path) state.paths.push(path);
    if (command === "list_dir") {
      if (state.mode === "timeout") throw new Error("The read timed out");
      if (path.endsWith("/.claude/skills")) return skillDir(path);
      if (state.mode === "both" && path.endsWith("/.codex/skills")) return skillDir(path);
      return [];
    }
    if (command === "read_text_file") {
      if (state.mode === "hang" && path.endsWith("/.claude/skills/review-only/SKILL.md")) {
        return state.hang;
      }
      if (path.endsWith("/SKILL.md")) return "---\r\nname: review-only\r\n---\r\n";
      return null;
    }
    return null;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(props: { from?: string; to?: string; toLabel?: string; cwd?: string }) {
  await act(async () => {
    root.render(
      createElement(SkillSwitchNotice, {
        from: props.from ?? "claude",
        to: props.to ?? "codex",
        toLabel: props.toLabel ?? "Codex",
        cwd: props.cwd ?? "C:/repo",
      }),
    );
  });
}

describe("skill switch pairs", () => {
  it("says a handoff and the same mid-thread switch once", () => {
    expect(
      skillSwitchPairs({ from: "claude", to: "codex" }, "claude", "codex"),
    ).toEqual([{ from: "claude", to: "codex" }]);
    expect(
      skillSwitchPairs({ from: "claude", to: "codex" }, "claude", "cursor"),
    ).toEqual([
      { from: "claude", to: "codex" },
      { from: "claude", to: "cursor" },
    ]);
    expect(skillSwitchPairs({ from: "codex", to: "codex" }, undefined, "claude")).toEqual([]);
    expect(skillSwitchPairs(undefined, "claude", undefined)).toEqual([]);
  });
});

describe("skill switch notice", () => {
  it("says what will not be visible to the CLI being switched to", async () => {
    await show({ cwd: "C:/my notes" });
    const notice = container.querySelector("[data-skill-switch-notice]");
    expect(notice?.textContent).toBe("This will not be visible to Codex: review-only.");
    expect(container.textContent).not.toMatch(/[—–]/);
    expect(container.textContent).not.toContain("/Users/");
    expect(state.paths.some((path) => path.includes("my notes/.claude/skills"))).toBe(true);
  });

  it("says nothing when every skill the current CLI has also loads for the next one", async () => {
    state.mode = "both";
    await show({});
    expect(container.querySelector("[data-skill-switch-notice]")).toBeNull();
    expect(container.textContent).not.toContain(SKILL_SWITCH_CHECKING);
  });

  it("treats a timeout as something to try again, not as everything travelling", async () => {
    state.mode = "timeout";
    await show({});
    expect(container.textContent).toContain("Reading this project timed out. Try again.");
    expect(container.querySelector("[data-skill-switch-notice]")).not.toBeNull();
    state.mode = "claude-only";
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Try again");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("This will not be visible to Codex: review-only.");
    expect(container.textContent).not.toContain("timed out");
  });

  it("drops a result that arrives after the switch target changed", async () => {
    const slow = deferred<string>();
    state.mode = "hang";
    state.hang = slow.promise;
    await show({ to: "codex", toLabel: "Codex" });
    expect(container.textContent).toContain(SKILL_SWITCH_CHECKING);
    state.mode = "claude-only";
    await show({ to: "cursor", toLabel: "Cursor" });
    expect(container.textContent).toContain("This will not be visible to Cursor: review-only.");
    await act(async () => {
      slow.resolve("---\nname: late-skill\n---\n");
    });
    expect(container.textContent).toContain("This will not be visible to Cursor: review-only.");
    expect(container.textContent).not.toContain("late-skill");
    expect(container.textContent).not.toContain("visible to Codex");
  });

  it("ignores a result after the switch is taken off", async () => {
    const slow = deferred<string>();
    state.mode = "hang";
    state.hang = slow.promise;
    await show({});
    await show({ from: "codex", to: "codex" });
    await act(async () => {
      slow.resolve("---\nname: review-only\n---\n");
    });
    expect(container.querySelector("[data-skill-switch-notice]")).toBeNull();
  });

  it("does not read a project that is not open", async () => {
    await show({ cwd: "~" });
    expect(container.querySelector("[data-skill-switch-notice]")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    await show({ cwd: "" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("says when the home folder cannot be read", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "home_dir") return "  ";
      return null;
    });
    await show({});
    expect(container.textContent).toContain("Could not read this project's files. Try again.");
  });
});
