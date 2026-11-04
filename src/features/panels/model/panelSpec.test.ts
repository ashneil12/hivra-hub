import { expect, it } from "vitest";
import { readPanelDir } from "./panelSpec";

const note = { kind: "note", title: "Hello", text: "Example: a note" };

it("reads a blocks panel and grants nothing", () => {
  const read = readPanelDir("board", {
    "panel.json": JSON.stringify({ kind: "blocks", title: "Board", blocks: [note] }),
  });
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.value.permissions).toEqual([]);
  expect(read.value.spec).toMatchObject({ kind: "blocks", title: "Board" });
});

it("reads a bespoke panel from the files beside panel.json, with only the permissions it lists", () => {
  const read = readPanelDir("custom", {
    "panel.json": JSON.stringify({ kind: "bespoke", title: "Custom", permissions: ["tasks.read", "tasks.read"] }),
    "index.html": "<p>Example: board</p>",
    "style.css": "p{color:red}",
    "script.js": "hub.call('tasks.read')",
  });
  expect(read.ok).toBe(true);
  if (!read.ok || read.value.spec.kind !== "bespoke") return;
  expect(read.value.spec.html).toBe("<p>Example: board</p>");
  expect(read.value.spec.css).toBe("p{color:red}");
  expect(read.value.permissions).toEqual(["tasks.read"]);
});

it("keeps a line break inside HTML and refuses a path that leaves the folder", () => {
  const kept = readPanelDir("custom", {
    "panel.json": JSON.stringify({ kind: "bespoke", title: "Custom", permissions: [] }),
    "index.html": "a\r\nb",
  });
  expect(kept.ok).toBe(true);
  if (kept.ok && kept.value.spec.kind === "bespoke") expect(kept.value.spec.html).toBe("a\r\nb");

  expect(readPanelDir("custom", { "../secret": "no", "panel.json": "{}" }).ok).toBe(false);
  expect(readPanelDir("custom", { "sub/panel.json": "{}" }).ok).toBe(false);
  expect(readPanelDir("../custom", { "panel.json": "{}" }).ok).toBe(false);
  expect(readPanelDir("", { "panel.json": "{}" }).ok).toBe(false);
});

it("refuses a missing file, a bad permission, a wall and an extra field", () => {
  expect(readPanelDir("custom", {}).ok).toBe(false);
  expect(readPanelDir("custom", { "panel.json": "not json" }).ok).toBe(false);
  expect(readPanelDir("custom", {
    "panel.json": JSON.stringify({ kind: "bespoke", title: "Custom", permissions: ["tasks.read"] }),
  }).ok).toBe(false);
  const wall = readPanelDir("custom", {
    "panel.json": JSON.stringify({ kind: "bespoke", title: "Custom", permissions: ["ipc"] }),
    "index.html": "<p>x</p>",
  });
  expect(wall.ok).toBe(false);
  const unknown = readPanelDir("custom", {
    "panel.json": JSON.stringify({ kind: "bespoke", title: "Custom", permissions: ["keys.read"] }),
    "index.html": "<p>x</p>",
  });
  expect(unknown.ok).toBe(false);
  const extra = readPanelDir("board", {
    "panel.json": JSON.stringify({ kind: "blocks", title: "Board", blocks: [note], html: "<p>no</p>" }),
  });
  expect(extra.ok).toBe(false);
});

it("refuses an empty title and an unknown block", () => {
  expect(readPanelDir("board", {
    "panel.json": JSON.stringify({ kind: "blocks", title: "", blocks: [note] }),
  }).ok).toBe(false);
  expect(readPanelDir("board", {
    "panel.json": JSON.stringify({ kind: "blocks", title: "Board", blocks: [{ kind: "nope", title: "X" }] }),
  }).ok).toBe(false);
});
