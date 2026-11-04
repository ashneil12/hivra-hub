import { expect, it } from "vitest";
import { MY_PANELS_ID, MY_PANELS_TITLE, mergeMyPanels, type KeptPage } from "./myPanels";

const note = { kind: "note", title: "Hello", text: "Example: a note" };

function kept(id: string, spec: unknown, over: Partial<KeptPage> = {}): KeptPage {
  return { id, keptAt: 10, spec, ...over };
}

it("turns kept pages into a My panels plugin and leaves a second pass unchanged", () => {
  const pages = [
    kept("Board", { kind: "blocks", title: "看板", blocks: [note] }),
    kept("custom", { kind: "bespoke", title: "Custom", html: "a\r\nb", css: "p{}", permissions: ["tasks.read"] }),
  ];
  const first = mergeMyPanels({}, pages);
  expect(first.added).toEqual(["board", "custom"]);
  const plugin = JSON.parse(first.files["plugin.json"]);
  expect(plugin).toMatchObject({ name: MY_PANELS_ID, description: MY_PANELS_TITLE, version: "1.0.0" });
  expect(JSON.parse(first.files["hivra/panels/board/panel.json"]).title).toBe("看板");
  expect(first.files["hivra/panels/custom/index.html"]).toBe("a\r\nb");
  expect(first.files["hivra/panels/custom/style.css"]).toBe("p{}");
  expect(JSON.parse(first.files["hivra/panels/custom/panel.json"]).permissions).toEqual(["tasks.read"]);

  const second = mergeMyPanels(first.files, pages);
  expect(second.added).toEqual([]);
  expect(second.files["hivra/panels/board/panel.json"]).toBe(first.files["hivra/panels/board/panel.json"]);
});

it("skips a page that is not kept, removed, duplicated, invalid, or a path", () => {
  const merged = mergeMyPanels({}, [
    kept("ok", { kind: "blocks", title: "Ok", blocks: [note] }),
    kept("ok", { kind: "blocks", title: "Again", blocks: [note] }),
    { id: "preview", spec: { kind: "blocks", title: "Preview", blocks: [note] } },
    kept("gone", { kind: "blocks", title: "Gone", blocks: [note] }, { removed: true }),
    kept("../secret", { kind: "blocks", title: "Secret", blocks: [note] }),
    kept("C:\\secret", { kind: "blocks", title: "Win", blocks: [note] }),
    kept("bad", { kind: "blocks", title: "", blocks: [] }),
    kept("", { kind: "blocks", title: "No id", blocks: [note] }),
  ]);
  expect(merged.added).toEqual(["ok"]);
  expect(Object.keys(merged.files).some((key) => key.includes("..") || key.includes("secret"))).toBe(false);
  expect(merged.skipped).toContain("../secret");
  expect(merged.skipped).toContain("gone");
});

it("does not overwrite a panel someone edited, or a description they changed", () => {
  const edited = "panel someone edited";
  const merged = mergeMyPanels(
    {
      "plugin.json": JSON.stringify({ name: MY_PANELS_ID, version: "1.0.0", description: "Edited" }),
      "hivra/panels/board/panel.json": edited,
      "../outside": "no",
    },
    [kept("board", { kind: "blocks", title: "New", blocks: [note] }), kept("Page_1", { kind: "blocks", title: "Other", blocks: [note] })],
  );
  expect(merged.files["hivra/panels/board/panel.json"]).toBe(edited);
  expect(merged.files["../outside"]).toBeUndefined();
  expect(JSON.parse(merged.files["plugin.json"]).description).toBe("Edited");
  expect(merged.added).toEqual(["page-1"]);
});

it("makes no plugin when nothing is kept", () => {
  expect(mergeMyPanels({}, []).files).toEqual({});
  expect(mergeMyPanels({}, [kept("x", { kind: "nope" })]).files).toEqual({});
});

it("gives a second page its own folder when the names collide", () => {
  const merged = mergeMyPanels({}, [
    kept("Page_1", { kind: "blocks", title: "One", blocks: [note] }),
    kept("page-1", { kind: "blocks", title: "Two", blocks: [note] }),
  ]);
  expect(merged.added).toEqual(["page-1", "page-1-2"]);
});
