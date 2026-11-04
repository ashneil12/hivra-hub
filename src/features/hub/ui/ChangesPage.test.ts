// @vitest-environment happy-dom
// A soul refresh as Ash meets it (14 Oct rule: applied on its own, in Bot changes with Undo, no Apply / Dismiss card):
// the row reads as what changes for the Mono in plain sentences, never a diff or a file path, and Undo puts it back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordBotChange, recordBotNote, setBotFiles } from "../model/botChanges";
import { refreshSouls, skippedLine } from "../model/soulRefresh";
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

it("a skipped soul's row says the update was left, and does not offer to ask a named Mono", () => {
  recordBotNote({ id: "soul-skip:nibbii-lead:x", bot: "Nibbii lead", monoId: "nibbii-lead", line: skippedLine("Nibbii lead"), now: "Your own version", after: "Left as it is" });
  openBots();
  const row = rowWith("Nibbii lead's soul has your own changes");
  expect([...row.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Undo");
  expect(row.querySelector("[data-hub-bot-change-ask]")).toBeNull();
  expect(row.textContent ?? "").not.toMatch(/\bAlfred\b/);
});

it("one Undo all from… button, whose menu names each Mono", async () => {
  const files = new Map<string, string>([["a/RULES.md", "a1"], ["b/RULES.md", "b1"]]);
  const read = async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: `h:${files.get(`${id}/${path}`) ?? ""}` });
  const write = async (id: string, path: AgentFilePath, text: string) => {
    files.set(`${id}/${path}`, text);
    return `h:${text}`;
  };
  setBotFiles({ read, write });
  for (const [id, bot] of [["a", "Hivra lead"], ["b", "ed"]] as const) {
    files.set(`${id}/RULES.md`, `${id}2`);
    recordBotChange({ id: `rules:${id}`, bot, day: "Today", line: `${bot} changed how it works`, now: "Old", after: "New", monoId: id, file: "RULES.md" as AgentFilePath, beforeText: `${id}1`, afterText: `${id}2` });
  }
  openBots();
  const buttons = [...container.querySelectorAll("[data-undo-all-from] button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Undo all from…"]);
  expect(container.querySelector("[data-undo-all-from-menu]")).toBeNull();
  act(() => (buttons[0] as HTMLButtonElement).click());
  const items = [...container.querySelectorAll("[data-undo-all-from-item]")];
  expect(new Set(items.map((i) => i.textContent))).toEqual(new Set(["Hivra lead", "ed"]));
  await act(async () => (container.querySelector('[data-undo-all-from-item="ed"]') as HTMLButtonElement).click());
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

it("a put-back soul's row offers 'Keep that change' in place of Undo", () => {
  recordBotChange({ id: "soul-put-back:hivra-lead:x", bot: "Hivra lead", day: "Today", line: "Something outside the app changed Hivra lead's soul while a worker was running, so it was put back.", now: "Changed from outside the app", after: "Back to the soul the app last saved", undoLabel: "Keep that change", monoId: "hivra-lead", file: "SOUL.md", beforeText: "a", afterText: "b" });
  openBots();
  const row = rowWith("while a worker was running");
  expect(row.querySelector("[data-hub-bot-change-undo]")!.textContent).toBe("Keep that change");
});

it("a two-line row's 'and 4 more' opens it, and so does a click anywhere on the row (Mac round 2)", async () => {
  // As on the Mac: a Lead's refresh row long enough to wrap, its "and 4 more" at the end of the second line.
  const line = "Hivra lead will now act as an orchestrator: small things itself, and bigger pieces to workers in the user's own words. (and 4 more)";
  const details = ["one", "two", "three", "four", "Hivra lead kept its old folder because its project's folder wasn't found on this Mac."];
  const files = new Map<string, string>([["hivra-lead/SOUL.md", "after"]]);
  setBotFiles({ read: async (id, p) => ({ text: files.get(`${id}/${p}`) ?? null, hash: `h:${files.get(`${id}/${p}`) ?? ""}` }), write: async (id, p, t) => (files.set(`${id}/${p}`, t), `h:${t}`) });
  recordBotChange({ id: "soul-refresh:hivra-lead:wrap", bot: "Hivra lead", day: "Today", line, now: "Its soul as it was", after: "Its soul on the app's newer version", details, monoId: "hivra-lead", file: "SOUL.md", beforeText: "before", afterText: "after" });
  openBots();
  const row = rowWith("Hivra lead will now act") as HTMLElement;
  const shown = () => row.querySelectorAll("[data-hub-bot-change-details] li").length;
  const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  // On the "and 4 more" itself (the span, as a pointer lands on it): opens on the full list.
  const more = row.querySelector("[data-hub-bot-change-more]")!;
  expect(more.textContent).toBe("and 4 more");
  click(more);
  expect(shown()).toBe(5);
  expect(row.textContent).toContain("kept its old folder");
  // Reading the opened list doesn't close it.
  click(row.querySelector("[data-hub-bot-change-details] li")!);
  expect(shown()).toBe(5);
  // The row's own padding (under the second line, beside the text): closes, then opens again.
  click(row);
  expect(shown()).toBe(0);
  click(row.firstElementChild!);
  expect(shown()).toBe(5);
  // A drag that selected some of the line isn't a click on the row.
  const sel = window.getSelection()!;
  sel.selectAllChildren(row.querySelector("[data-hub-bot-change-line]")!);
  click(row);
  expect(shown()).toBe(5);
  sel.removeAllRanges();
  // Undo acts alone: the row stays open and the soul goes back.
  await act(async () => (row.querySelector("[data-hub-bot-change-undo]") as HTMLButtonElement).click());
  await vi.waitFor(() => expect(files.get("hivra-lead/SOUL.md")).toBe("before"));
  expect(shown()).toBe(5);
});
