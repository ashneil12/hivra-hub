// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMono, findMono, listMonos, updateMono } from "../../features/monos/model/mono";
import { loadMonosEnabled } from "../../features/settings/model/settings";
import { MonoRailSection } from "./MonoRailSection";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
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

function render(props: Partial<Parameters<typeof MonoRailSection>[0]> = {}) {
  const onCreate = vi.fn();
  act(() =>
    root.render(
      createElement(MonoRailSection, {
        states: new Map(),
        onOpen: () => {},
        onCreate,
        onDelete: () => {},
        ...props,
      }),
    ),
  );
  return onCreate;
}

const intro = () => document.body.querySelector('[aria-label="Meet Monos"]');
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  )!;

it("shows the intro card in place of the list while there is no mono", () => {
  const onCreate = render();
  expect(intro()).not.toBeNull();
  expect(container.querySelector('[aria-label="New mono"]')).toBeNull();

  act(() => button("Create mono").click());
  expect(onCreate).toHaveBeenCalledOnce();
});

it("turns monos off from the intro's switch", () => {
  render();
  act(() => container.querySelector<HTMLElement>('[role="switch"]')!.click());
  expect(loadMonosEnabled()).toBe(false);
});

it("lists monos once there are some, with the plus in the header", () => {
  createMono();
  render();
  expect(intro()).toBeNull();
  expect(container.querySelectorAll('[aria-label="New mono"]')).toHaveLength(1);
});

it("puts a pinned Mono first and shows no unread badge on a muted one", () => {
  const milo = createMono();
  const ada = createMono();
  updateMono(milo.id, (mono) => ({ ...mono, name: "Milo", muted: true }));
  updateMono(ada.id, (mono) => ({ ...mono, name: "Ada", pinned: true }));
  render({ unseenCounts: new Map([[milo.id, 4], [ada.id, 2]]) });
  const names = [...container.querySelectorAll("[data-mono-primary-name]")].map((el) => el.textContent);
  expect(names[0]).toBe("Ada");
  expect(names).toContain("Milo");
  expect([...container.querySelectorAll("[data-mono-unread]")].map((el) => el.textContent)).toEqual(["2"]);
});

it("pins, mutes and renames from the options menu", () => {
  const milo = createMono();
  const ada = createMono();
  updateMono(milo.id, (mono) => ({ ...mono, name: "Milo" }));
  updateMono(ada.id, (mono) => ({ ...mono, name: "Ada" }));
  render({ unseenCounts: new Map([[ada.id, 3]]) });
  const names = () => [...container.querySelectorAll("[data-mono-primary-name]")].map((el) => el.textContent);
  const item = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) => el.textContent?.replace(/\s+/g, " ").trim() === label);
  act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Ada options"]')!.click());
  expect(item("Pin")).toBeTruthy();
  expect(item("Mute")).toBeTruthy();
  expect(item("Duplicate")).toBeTruthy();
  expect(item("Edit profile")).toBeTruthy();
  expect(item("Remove")).toBeUndefined();
  act(() => item("Pin")!.click());
  expect(names()[0]).toBe("Ada");
  expect(findMono(ada.id)?.pinned).toBe(true);
  act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Ada options"]')!.click());
  act(() => item("Mute")!.click());
  expect([...container.querySelectorAll("[data-mono-unread]")].map((el) => el.textContent)).toEqual([]);
  expect(findMono(ada.id)?.muted).toBe(true);
  act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Ada options"]')!.click());
  act(() => item("Edit profile")!.click());
  const input = document.body.querySelector<HTMLInputElement>('[aria-label="Mono name"]');
  expect(input).not.toBeNull();
  act(() => {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    proto?.set?.call(input, "Ada L");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(names()).toContain("Ada L");
  expect(findMono(ada.id)?.name).toBe("Ada L");
  expect(listMonos().some((mono) => mono.id === milo.id)).toBe(true);
});

it("counts a mono's unread replies, except the one open", () => {
  const mono = createMono();
  const badge = () => container.querySelector("[data-mono-unread]");
  render({ unseenCounts: new Map([[mono.id, 3]]) });
  expect(badge()?.textContent).toBe("3");
  expect(
    container.querySelector(`[aria-label*="3 new replies"]`),
  ).not.toBeNull();

  render({ unseenCounts: new Map([[mono.id, 120]]) });
  expect(badge()?.textContent).toBe("99+");

  render({ activeId: mono.id, unseenCounts: new Map([[mono.id, 3]]) });
  expect(badge()).toBeNull();
});

it("hub, clean first launch: no default team, no intro card, no blue switch, one create button (New first mate)", async () => {
  vi.resetModules();
  const { addMono } = await import("../../features/monos/model/mono");
  const { hubMonoRank } = await import("../../features/hub/model/hubData");
  const { ensureBuiltInMonos, DEFAULT_TEAM_IDS } = await import("../../features/hub/model/builtInMonos");
  const names = () =>
    [...container.querySelectorAll("[data-mono-status] > button[title]")]
      .map((b) => b.getAttribute("title")!.split("\n")[0])
      .filter((t) => t !== "Mono options");
  expect(DEFAULT_TEAM_IDS).toEqual([]);
  expect(ensureBuiltInMonos()).toBe(0);
  render({ rank: hubMonoRank });
  expect(names()).toEqual([]);
  expect(intro()).toBeNull();
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.querySelector(".bg-accent")).toBeNull();
  expect([...container.querySelectorAll("button")].filter((b) => /create mono|new mono|new first mate/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))).toHaveLength(1);
  for (const [id, name] of [["ada", "Ada"], ["bo", "Bo"], ["ed", "Ed"], ["cam", "Cam"]] as const)
    addMono({ id, name, mascot: "robot", color: "gray", projects: [] });
  render({ rank: hubMonoRank });
  expect(names()).toEqual(["Ada", "Bo", "Ed", "Cam"]);
  // removed later: they don't come back by themselves
  localStorage.setItem("monocode:mono-roster", "[]");
  window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
  render({ rank: hubMonoRank });
  expect(ensureBuiltInMonos()).toBe(0);
  expect(container.querySelectorAll("[data-mono-status]")).toHaveLength(0);
});

it("r30d: a Mono's menu deletes its chat only (the Mono stays), and only once it has one", async () => {
  const { updateMono, findMono } = await import("../../features/monos/model/mono");
  const mono = createMono();
  const onDelete = vi.fn();
  const onDeleteChat = vi.fn();
  render({ onDelete, onDeleteChat });
  const openMenu = () => act(() => document.body.querySelector<HTMLButtonElement>('button[title="Mono options"]')!.click());
  const deleteChat = () => document.body.querySelector<HTMLButtonElement>("[data-mono-menu-delete-chat]");
  openMenu();
  expect(deleteChat()).toBeNull(); // no chat yet: nothing to delete
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  act(() => void updateMono(mono.id, (m) => ({ ...m, sessionId: "ex-mono-chat" })));
  render({ onDelete, onDeleteChat });
  if (!deleteChat()) openMenu();
  expect(deleteChat()?.textContent).toBe("Delete chat…");
  act(() => deleteChat()!.click());
  expect(onDeleteChat).toHaveBeenCalledWith(mono.id);
  expect(onDelete).not.toHaveBeenCalled();
  expect(findMono(mono.id)).toBeDefined();
});
