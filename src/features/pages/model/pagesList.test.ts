// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import { allPages, buildPreview, keepPage, pinnedPages, resetPagesForTest, setPinned } from "./pages";
import { checkBuiltSpec } from "./buildPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { localStorage.clear(); resetPagesForTest(); });

it("Pages lists every page across projects; pins by Ash or a Mono show as pinned", () => {
  keepPage(buildPreview("hivra sign-ups", "Hivra lead", 1, "hivra"));
  keepPage(buildPreview("exo bugs", "EXO lead", 2, "exo-game"));
  expect(allPages().map((p) => p.projectId).sort()).toEqual(["exo-game", "hivra"]);
  const [a, b] = allPages();
  setPinned(a.id, true);
  setPinned(b.id, true, "EXO lead");
  expect(pinnedPages().map((p) => p.pinnedBy).sort()).toEqual(["EXO lead", "you"]);
  setPinned(a.id, false);
  expect(pinnedPages()).toHaveLength(1);
});

it("a Mono can ask for its page to be pinned through the build result", async () => {
  const r = checkBuiltSpec({ kind: "blocks", title: "Example: board", blocks: [{ kind: "note", title: "Note", text: "Example: hi" }], pin: true });
  expect(r.status === "ready" && r.pin).toBe(true);
});

it("the list view: grouped by project, a pin on every row, New page is only a prompt box", async () => {
  keepPage(buildPreview("hivra sign-ups", "Hivra lead", 1, "hivra"));
  keepPage(buildPreview("exo bugs", "EXO lead", 2, "exo-game"));
  const { PagesContent } = await import("../ui/PagesView");
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(PagesContent)));
  expect(host.querySelectorAll("[data-pages-group]").length).toBe(2);
  expect(host.querySelectorAll("[data-pages-row] [data-pages-pin]").length).toBe(2);
  expect(host.querySelector("aside")).toBeNull();
  await act(async () => (host.querySelector("[data-pages-new-button]") as HTMLButtonElement).click());
  const view = host.querySelector("[data-pages-new]")!;
  expect(view.querySelectorAll("input").length).toBe(1);
  expect(view.querySelector("[data-pages-cant]")).not.toBeNull();
  expect(view.textContent).not.toMatch(/block|builder/i);
});
