// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorktreeStacks } from "./WorktreeStacks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

function stack(cwd: string) {
  return {
    declared: true,
    url: null,
    stacks: [
      {
        id: "s01234567",
        worktree: `${cwd}/tree`,
        composeProject: `hivra-${cwd}`,
        url: null,
        running: true,
        stale: false,
      },
    ],
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
  throw new Error(`timed out: ${host?.textContent ?? ""}`);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
});

it("does not show a stop error on the project you switched to", async () => {
  let rejectDown: (reason: unknown) => void = () => undefined;
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    const cwd = args && typeof args === "object" && "cwd" in args && typeof args.cwd === "string" ? args.cwd : "";
    if (command === "stack_status") return Promise.resolve(stack(cwd));
    if (command === "stack_down") {
      return new Promise((_resolve, reject) => {
        rejectDown = reject;
      });
    }
    return Promise.resolve(null);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(WorktreeStacks, { cwd: "/proj-a" }));
  });
  await until(() => (host?.textContent ?? "").includes("hivra-/proj-a"));
  await act(async () => {
    [...(host?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Stop")?.click();
  });
  expect(rejectDown).not.toBeUndefined();
  await act(async () => {
    root?.render(createElement(WorktreeStacks, { cwd: "/proj-b" }));
  });
  await until(() => (host?.textContent ?? "").includes("hivra-/proj-b"));
  await act(async () => {
    rejectDown("Docker didn't answer");
  });
  expect(host?.textContent ?? "").not.toContain("Docker didn't answer");
  expect(host?.textContent ?? "").toContain("hivra-/proj-b");
});
