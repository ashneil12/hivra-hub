// @vitest-environment happy-dom
// r65 (PM's r63 run): every Bot changes Undo was named just "Undo", and PM's Undo hit another row. Each button is named
// for its own change and acts on its own row only.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { botChangeRows, recordBotChange, setBotFiles } from "../model/botChanges";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import { ChangesPage } from "./ChangesPage";

vi.mock("../../monos/model/monoPrefill", () => ({ openMonoChatWith: vi.fn() }));

let container: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

it("each Undo and Redo is named for its change and undoes only its own row", async () => {
  const files = new Map<string, string>([["frank/SOUL.md", "after-f"], ["alfred/SOUL.md", "after-a"]]);
  setBotFiles({
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: `h:${files.get(`${id}/${path}`) ?? ""}` }),
    write: async (id: string, path: AgentFilePath, text: string) => (files.set(`${id}/${path}`, text), `h:${text}`),
  });
  recordBotChange({ id: "c-frank", bot: "frank", day: "Today", line: "frank shortened the release-notes skill", now: "12", after: "8", monoId: "frank", file: "SOUL.md", beforeText: "before-f", afterText: "after-f" });
  recordBotChange({ id: "c-alfred", bot: "alfred", day: "Today", line: "alfred now asks before deploying", now: "a", after: "b", monoId: "alfred", file: "SOUL.md", beforeText: "before-a", afterText: "after-a" });
  root = createRoot(container);
  act(() => root!.render(createElement(ChangesPage)));
  act(() => (container.querySelector('[data-hub-changes-filter="bots"]') as HTMLButtonElement).click());
  const undos = [...container.querySelectorAll<HTMLButtonElement>("[data-hub-bot-change-undo]")];
  expect(undos.map((b) => b.getAttribute("aria-label")).sort()).toEqual([
    "Undo: alfred now asks before deploying",
    "Undo: frank shortened the release-notes skill",
  ]);
  const frank = undos.find((b) => b.getAttribute("aria-label")!.includes("frank"))!;
  await act(async () => frank.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(files.get("frank/SOUL.md")).toBe("before-f");
  expect(files.get("alfred/SOUL.md")).toBe("after-a");
  const rows = botChangeRows();
  const state = (id: string) => rows.find((r) => r.kind === "one" && r.change.id === id);
  expect(state("c-frank")?.kind === "one" && state("c-frank")!.kind === "one" ? (state("c-frank") as { change: { undone?: boolean } }).change.undone : null).toBe(true);
  expect((state("c-alfred") as { change: { undone?: boolean } }).change.undone).toBeFalsy();
  const redo = container.querySelector<HTMLButtonElement>("[data-hub-bot-change-redo]")!;
  expect(redo.getAttribute("aria-label")).toBe("Redo: frank shortened the release-notes skill");
  // Keys can't collide between rows.
  const keys = [...container.querySelectorAll("[data-hub-bot-change-row]")].map((e) => e.getAttribute("data-hub-bot-change-row"));
  expect(new Set(keys).size).toBe(keys.length);
});
