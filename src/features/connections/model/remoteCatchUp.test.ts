// @vitest-environment happy-dom
// Reconnecting to a remote project shows what the host did, and a closed view does not keep that page.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catchUpKey } from "../../firstmate/host/remoteFirstMate";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("does not keep a catch-up page that arrives after the view is gone", async () => {
  vi.resetModules();
  const core = await import("@tauri-apps/api/core");
  const projects = await import("./remoteProjects");
  const connections = await import("./connections");
  const cwd = projects.remotePath("env-1", "/work/app");
  projects.rememberRemoteProject("env-1", { id: "proj-1", cwd: "/work/app", name: "App" });
  let release: (value: unknown) => void = () => {};
  vi.mocked(core.invoke).mockImplementation(async (command: string, input?: { method?: string }) => {
    if (command === "remote_machines") {
      return [{ id: "machine-1", name: "box", endpoint: "http://127.0.0.1:1", environmentId: "env-1" }];
    }
    if (input?.method === "sessions.list") return [];
    if (input?.method === "firstmate.catchUp") return new Promise((resolve) => {
      release = resolve;
    });
    return [];
  });

  function Probe() {
    connections.useRemoteProjectSessions(cwd);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  await vi.waitFor(() => {
    expect(
      vi.mocked(core.invoke).mock.calls.some((call) => call[1]?.method === "firstmate.catchUp"),
    ).toBe(true);
  });
  await act(async () => {
    root.unmount();
  });
  await act(async () => {
    release({
      entries: [
        {
          seq: 1,
          projectId: "proj-1",
          delegationId: "d1",
          ownerSession: "owner-1",
          kind: "finished",
          startedBy: "person",
          text: "The change is in.",
          at: 1,
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(localStorage.getItem(catchUpKey("env-1", "proj-1"))).toBeNull();
});
