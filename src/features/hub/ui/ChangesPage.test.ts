// @vitest-environment happy-dom
// A soul refresh as Ash meets it (14 Oct rule: applied on its own, in Bot changes with Undo, no Apply / Dismiss card):
// the row reads as what changes for the Mono in plain sentences, never a diff or a file path, and Undo puts it back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setBotFiles } from "../model/botChanges";
import { refreshSouls } from "../model/soulRefresh";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import { ChangesPage } from "./ChangesPage";

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

const OLD = "# Soul\n\n## Your job\n- You are mainly an orchestrator.\n";
const NEW = "# Soul\n\n## Your job\n- You are mainly an orchestrator.\n- Ask before handing work to Ash.\n\n## Finishing\n- Prove it.\n";

it("shows the refresh as plain sentences with Undo, no Apply or Dismiss, no file text; Undo restores the soul", async () => {
  const files = new Map<string, string>([["nibbii-lead/SOUL.md", OLD], ["nibbii-lead/soul-template.md", OLD]]);
  const read = async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: `h:${files.get(`${id}/${path}`) ?? ""}` });
  const write = async (id: string, path: AgentFilePath, text: string, expected?: string) => {
    if (expected !== undefined && `h:${files.get(`${id}/${path}`) ?? ""}` !== expected) throw "conflict";
    files.set(`${id}/${path}`, text);
    return `h:${text}`;
  };
  setBotFiles({ read, write });
  await refreshSouls({ read, write }, [{ monoId: "nibbii-lead", name: "Nibbii lead", template: NEW }]);
  expect(files.get("nibbii-lead/SOUL.md")).toBe(NEW);

  root = createRoot(container);
  act(() => root!.render(createElement(ChangesPage)));
  act(() => (container.querySelector('[data-hub-changes-filter="bots"]') as HTMLButtonElement).click());
  const row = [...container.querySelectorAll("[data-hub-bot-change]")].find((r) => r.textContent?.includes("Nibbii lead"))!;
  expect(row).toBeTruthy();
  expect(row.querySelector("[data-hub-bot-change-apply], [data-hub-bot-change-dismiss], pre")).toBeNull();
  act(() => (row.querySelector("button[aria-expanded]") as HTMLButtonElement).click());
  const details = [...row.querySelectorAll("[data-hub-bot-change-details] li")].map((li) => li.textContent);
  expect(details[0]).toMatch(/^Nibbii lead will now act as an orchestrator/);
  expect(details[1]).toMatch(/^Nibbii lead will now prove its own work/);
  expect(row.textContent).not.toMatch(/SOUL|\.md|##|nibbii-lead|Prove it/);

  const undo = [...row.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
  await act(async () => undo.click());
  await vi.waitFor(() => expect(files.get("nibbii-lead/SOUL.md")).toBe(OLD));
});
