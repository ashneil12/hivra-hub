import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const pages = readFileSync(new URL("./PagesView.tsx", import.meta.url), "utf8");
const change = readFileSync(new URL("../../hubChange/ui/HubChangeView.tsx", import.meta.url), "utf8");

it("the note after Keep (and after Apply) has its own Undo and no Settings path", () => {
  expect(pages).toMatch(/data-pages-undo-keep[\s\S]{0,200}undoBotChange\(\[`page:\$\{id\}`\]\)/);
  expect(change).toMatch(/data-hub-change-undo[\s\S]{0,200}undoBotChange\(\[`hub:\$\{r\.preview\.previewId\}`\]\)/);
  expect(pages + change).not.toContain("Settings → Changes");
});
