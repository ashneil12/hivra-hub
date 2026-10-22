import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// Imported up front: PagesView pulls in the hub's stores, and loading them inside a test can pass its 5 s limit on a busy Mac.
import { allowedLabel } from "./PagesView";

const pages = readFileSync(new URL("./PagesView.tsx", import.meta.url), "utf8");
const change = readFileSync(new URL("../../hubChange/ui/HubChangeView.tsx", import.meta.url), "utf8");

it("the note after Keep (and after Apply) has its own Undo and no Settings path", () => {
  expect(pages).toMatch(/data-pages-undo-keep[\s\S]{0,200}undoBotChange\(\[`page:\$\{id\}`\]\)/);
  // The applied change's Undo goes straight to Ash OS's record (the same change Bot changes lists).
  expect(change).toMatch(/data-hub-change-undo[\s\S]{0,200}undoChange\(r\.preview\.previewId\)/);
  expect(pages + change).not.toContain("Settings → Changes");
});

it("a kept page's line reads Allowed: N things", () => {
  expect(allowedLabel(1)).toBe("Allowed: 1 thing");
  expect(allowedLabel(3)).toBe("Allowed: 3 things");
  expect(pages).toMatch(/data-pages-allowed-list/);
});

it("an imported page that already says Kept asks with Allow, and Allow works at once", () => {
  const block = pages.slice(pages.indexOf("function AllowAgain"), pages.indexOf("function AskBox"));
  expect(block).toMatch(/onClick=\{\(\) => allowPage\(page\.id\)\}>Allow<\/button>/);
  // Nothing to wait behind now that a page can never ask for a key (pageSpec.ts): no delay, nothing disabled.
  expect(block).not.toMatch(/useKeyDelay/);
  expect(block).not.toMatch(/disabled=\{/);
  expect(block).not.toContain("Keep and allow");
});
