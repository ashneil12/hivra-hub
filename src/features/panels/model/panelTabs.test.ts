import { expect, it } from "vitest";
import { applyCatalog, openTab, readCatalog, type PanelBoard } from "./panelTabs";

const note = { kind: "note" as const, title: "Hello", text: "Example: a note" };
const blocks = { kind: "blocks" as const, title: "Board", blocks: [note] };
const empty: PanelBoard = { rev: 0, tabs: [] };

it("opens a panel once and focuses it the second time", () => {
  const once = openTab(empty, { plugin: "my-panels", panelId: "board" }, "t1");
  const twice = openTab(once, { plugin: "my-panels", panelId: "board" }, "t2");
  expect(twice.tabs).toHaveLength(1);
  expect(twice.active).toBe("t1");
  expect(openTab(empty, { plugin: "", panelId: "board" }, "t")).toBe(empty);
  expect(openTab(empty, { plugin: "my-panels", panelId: "" }, "t")).toBe(empty);
});

it("drops a tab when its plugin leaves the catalog, and ignores a stale revision", () => {
  const open = openTab(openTab(empty, { plugin: "my-panels", panelId: "board" }, "t1"), { plugin: "other", panelId: "board" }, "t2");
  const next = applyCatalog(open, 2, [{ plugin: "other", panelId: "board" }]);
  expect(next.tabs.map((tab) => tab.tabId)).toEqual(["t2"]);
  expect(next.active).toBe("t2");
  const stale = applyCatalog(next, 1, [{ plugin: "my-panels", panelId: "board" }, { plugin: "other", panelId: "board" }]);
  expect(stale).toBe(next);
  const cleared = applyCatalog(next, 3, []);
  expect(cleared.tabs).toEqual([]);
  expect(cleared.active).toBeUndefined();
});

it("applies an equal revision again and keeps a tab that is still offered", () => {
  const open = openTab(empty, { plugin: "my-panels", panelId: "board" }, "t1");
  const again = applyCatalog({ ...open, rev: 4 }, 4, [{ plugin: "my-panels", panelId: "board" }]);
  expect(again.tabs).toHaveLength(1);
  expect(again.rev).toBe(4);
});

it("reads a catalog and drops a bad spec, a path and a duplicate", () => {
  const read = readCatalog([
    { plugin: "my-panels", id: "board", spec: blocks },
    { plugin: "my-panels", id: "board", spec: blocks },
    { plugin: "../x", id: "board", spec: blocks },
    { plugin: "my-panels", id: "nope", spec: { kind: "bespoke", title: "X", html: "<p>x</p>", permissions: ["keys.read"] } },
    null,
    { plugin: "", id: "board", spec: blocks },
  ]);
  expect(read).toHaveLength(1);
  expect(read[0]).toMatchObject({ plugin: "my-panels", panelId: "board", title: "Board" });
  expect(readCatalog("nope")).toEqual([]);
  expect(readCatalog(undefined)).toEqual([]);
});
