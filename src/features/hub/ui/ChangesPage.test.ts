// @vitest-environment happy-dom
// A soul refresh as Ash meets it (14 Oct rule: applied on its own, in Bot changes with Undo, no Apply / Dismiss card):
// the row reads as what changes for the Mono in plain sentences, never a diff or a file path, and Undo puts it back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordBotChange, recordBotNote, setBotFiles } from "../model/botChanges";
import { openMonoChatWith } from "../../monos/model/monoPrefill";
import { askAlfred, refreshSouls, skippedLine } from "../model/soulRefresh";

vi.mock("../../monos/model/monoPrefill", () => ({ openMonoChatWith: vi.fn() }));
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

function openBots() {
  root = createRoot(container);
  act(() => root!.render(createElement(ChangesPage)));
  act(() => (container.querySelector('[data-hub-changes-filter="bots"]') as HTMLButtonElement).click());
}
const rowWith = (text: string) => [...container.querySelectorAll("[data-hub-bot-change]")].find((r) => r.textContent?.includes(text))!;

it("a skipped soul's row has an Ask Alfred button that opens Alfred's chat with the ask typed in", () => {
  recordBotNote({ id: "soul-skip:nibbii-lead:x", bot: "Nibbii lead", monoId: "nibbii-lead", line: skippedLine("Nibbii lead"), now: "Your own version", after: "Left as it is", ask: askAlfred("Nibbii lead") });
  openBots();
  const row = rowWith("Nibbii lead's soul has your own changes");
  expect([...row.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Undo");
  const ask = row.querySelector("[data-hub-bot-change-ask]") as HTMLButtonElement;
  expect(ask.textContent).toBe("Ask Alfred");
  act(() => ask.click());
  expect(openMonoChatWith).toHaveBeenCalledWith("alfred", "merge Nibbii lead's update");
});

it("one Undo all from… button, whose menu names each Mono", async () => {
  const files = new Map<string, string>([["a/RULES.md", "a1"], ["b/RULES.md", "b1"]]);
  const read = async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: `h:${files.get(`${id}/${path}`) ?? ""}` });
  const write = async (id: string, path: AgentFilePath, text: string) => {
    files.set(`${id}/${path}`, text);
    return `h:${text}`;
  };
  setBotFiles({ read, write });
  for (const [id, bot] of [["a", "Hivra lead"], ["b", "frank"]] as const) {
    files.set(`${id}/RULES.md`, `${id}2`);
    recordBotChange({ id: `rules:${id}`, bot, day: "Today", line: `${bot} changed how it works`, now: "Old", after: "New", monoId: id, file: "RULES.md" as AgentFilePath, beforeText: `${id}1`, afterText: `${id}2` });
  }
  openBots();
  const buttons = [...container.querySelectorAll("[data-undo-all-from] button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Undo all from…"]);
  expect(container.querySelector("[data-undo-all-from-menu]")).toBeNull();
  act(() => (buttons[0] as HTMLButtonElement).click());
  const items = [...container.querySelectorAll("[data-undo-all-from-item]")];
  expect(new Set(items.map((i) => i.textContent))).toEqual(new Set(["Hivra lead", "frank"]));
  await act(async () => (container.querySelector('[data-undo-all-from-item="frank"]') as HTMLButtonElement).click());
  await vi.waitFor(() => expect(files.get("b/RULES.md")).toBe("b1"));
  expect(files.get("a/RULES.md")).toBe("a2");
  expect(container.querySelector("[data-undo-all-from-menu]")).toBeNull();
});

it("a long row wraps rather than being cut off, its '(and N more)' opens the full list, and Undo reads as a sentence", async () => {
  const files = new Map<string, string>([["hivra-lead/SOUL.md", OLD], ["hivra-lead/soul-template.md", OLD]]);
  const read = async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: `h:${files.get(`${id}/${path}`) ?? ""}` });
  const write = async (id: string, path: AgentFilePath, text: string, expected?: string) => {
    if (expected !== undefined && `h:${files.get(`${id}/${path}`) ?? ""}` !== expected) throw "conflict";
    files.set(`${id}/${path}`, text);
    return `h:${text}`;
  };
  setBotFiles({ read, write });
  await refreshSouls({ read, write }, [{ monoId: "hivra-lead", name: "Hivra lead", template: NEW }]);
  openBots();
  const row = rowWith("Hivra lead will now");
  const line = row.querySelector("[data-hub-bot-change-line]") as HTMLButtonElement;
  expect(line.className).not.toContain("truncate");
  expect(line.className).toContain("break-words");
  expect(line.textContent).not.toContain("…");
  const more = line.querySelector("[data-hub-bot-change-more]")!;
  expect(more.textContent).toBe("and 1 more");
  act(() => line.click());
  expect(row.querySelectorAll("[data-hub-bot-change-details] li").length).toBe(2);
  const undo = [...row.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
  await act(async () => undo.click());
  await vi.waitFor(() => expect(row.querySelector("[data-hub-bot-change-undone]")?.textContent).toContain("Undone: Hivra lead's soul is back to how it was."));
  expect(row.querySelector("[data-hub-bot-change-undone]")!.textContent).not.toMatch(/Back to|Its soul|\(was /);
});
