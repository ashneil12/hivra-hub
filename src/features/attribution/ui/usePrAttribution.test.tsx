// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrAttribution } from "./usePrAttribution";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function Show({ repo, thread }: { repo: string; thread: unknown }) {
  const credit = usePrAttribution(repo, thread);
  return <p>{credit.agents.join(",") || "none"}</p>;
}

describe("usePrAttribution", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    invoke.mockReset();
  });

  function render(node: ReactNode) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(node));
  }

  it("does not ask when there are no commits", () => {
    render(createElement(Show, { repo: "/repo", thread: { commits: [] } }));
    expect(invoke).not.toHaveBeenCalled();
    expect(host.textContent).toBe("none");
  });

  it("keeps the list when the same commits are asked again and the read fails", async () => {
    let reject = (_reason?: unknown) => {};
    invoke.mockImplementation(
      () =>
        new Promise((resolve, rejectNext) => {
          reject = rejectNext;
          resolve({ agents: ["Ada"], tasks: [{ id: "task-1", title: "Fix the gate" }] });
        }),
    );
    const thread = { commits: [{ oid: "abc1234" }] };
    render(createElement(Show, { repo: "/repo", thread }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toBe("Ada");

    invoke.mockImplementation(() => Promise.reject(new Error("git didn't answer")));
    await act(async () => {
      root.render(createElement(Show, { repo: "/repo", thread: { commits: [{ oid: "abc1234" }] } }));
      await Promise.resolve();
    });
    expect(host.textContent).toBe("Ada");
    void reject;
  });

  it("clears when the commits change, and a failed read does not bring the old names back", async () => {
    invoke.mockImplementation(() => Promise.resolve({ agents: ["Ada"], tasks: [] }));
    render(createElement(Show, { repo: "/repo", thread: { commits: [{ oid: "abc1234" }] } }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toBe("Ada");

    invoke.mockImplementation(() => Promise.reject(new Error("git didn't answer")));
    await act(async () => {
      root.render(createElement(Show, { repo: "/repo", thread: { commits: [{ oid: "def5678" }] } }));
    });
    expect(host.textContent).toBe("none");
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toBe("none");
  });
});
