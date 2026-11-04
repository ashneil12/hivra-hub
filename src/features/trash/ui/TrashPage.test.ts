// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrashListItem } from "../model/trash";
import { TrashPage, type TrashClient } from "./TrashPage";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const chat: TrashListItem = {
  kind: "chat",
  id: "chat-1",
  title: "Notes about the plan",
  deletedAt: 1,
  version: 1,
  withCount: 0,
  payload: "{}",
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("a late list does not paint a chat a newer read already dropped", async () => {
  let resolveFirst: (rows: TrashListItem[]) => void = () => undefined;
  const first = new Promise<TrashListItem[]>((resolve) => {
    resolveFirst = resolve;
  });
  let calls = 0;
  const client: TrashClient = {
    list: () => {
      calls += 1;
      return calls === 1 ? first : Promise.resolve([]);
    },
    restore: async () => [],
    deleteForever: async () => 1,
    empty: async () => ({ purged: 0 }),
  };
  const render = (reloadToken: number) => {
    act(() => {
      root.render(
        createElement(TrashPage, {
          client,
          reloadToken,
          onPurgeProject: () => undefined,
        }),
      );
    });
  };
  render(0);
  render(1);
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.body.textContent).not.toContain("Notes about the plan");
  await act(async () => {
    resolveFirst([chat]);
    await first;
  });
  expect(document.body.textContent).not.toContain("Notes about the plan");
});

it("a missing event bridge still shows the trash", async () => {
  vi.mocked(listen).mockRejectedValueOnce(new Error("no tauri"));
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  const client: TrashClient = {
    list: async () => [chat],
    restore: async () => [],
    deleteForever: async () => 1,
    empty: async () => ({ purged: 0 }),
  };
  act(() => {
    root.render(
      createElement(TrashPage, {
        client,
        onPurgeProject: () => undefined,
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onRejection);
  expect(reasons).toEqual([]);
  expect(document.body.textContent).toContain("Notes about the plan");
});
