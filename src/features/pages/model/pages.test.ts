// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { buildPreview, keepPage, keptPages, resetPagesForTest } from "./pages";
import { botChangeRows, redoBotChange, undoBotChange } from "../../hub/model/botChanges";

beforeEach(() => { localStorage.clear(); resetPagesForTest(); });

it("matches a request to a layout of all five ready-made blocks", () => {
  const p = buildPreview("make me a dashboard for EXO bugs", "Projects Manager", 1);
  expect(p.title).toBe("EXO · Bugs and fixes");
  expect(p.blocks.map((b) => b.kind).sort()).toEqual(["calendar", "chart", "list", "note", "status"]);
  expect(p.blocks[0].kind).toBe("status");
  expect(buildPreview("my schedule this week", "frank", 2).blocks[0].kind).toBe("calendar");
});

it("Keep lists the page and adds a Bot changes row whose Undo takes it away again", async () => {
  const p = buildPreview("EXO bugs", "Projects Manager", 3);
  keepPage(p);
  expect(keptPages().map((x) => x.id)).toEqual([p.id]);
  const row = botChangeRows().find((r) => r.kind === "one" && r.change.pageId === p.id);
  expect(row).toBeTruthy();
  await undoBotChange([`page:${p.id}`]);
  expect(keptPages()).toEqual([]);
  await redoBotChange([`page:${p.id}`]);
  expect(keptPages().map((x) => x.id)).toEqual([p.id]);
});
