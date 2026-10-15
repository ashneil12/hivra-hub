import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const pages = readFileSync(new URL("./PagesView.tsx", import.meta.url), "utf8");
const change = readFileSync(new URL("../../hubChange/ui/HubChangeView.tsx", import.meta.url), "utf8");

it("the note after Keep (and after Apply) has its own Undo and no Settings path", () => {
  expect(pages).toMatch(/data-pages-undo-keep[\s\S]{0,200}undoBotChange\(\[`page:\$\{id\}`\]\)/);
  expect(change).toMatch(/data-hub-change-undo[\s\S]{0,200}undoBotChange\(\[`hub:\$\{r\.preview\.previewId\}`\]\)/);
  expect(pages + change).not.toContain("Settings → Changes");
});

it("a kept page's line reads Allowed: N things", async () => {
  const { allowedLabel } = await import("./PagesView");
  expect(allowedLabel(1)).toBe("Allowed: 1 thing");
  expect(allowedLabel(3)).toBe("Allowed: 3 things");
  expect(pages).toMatch(/data-pages-allowed-list/);
});
