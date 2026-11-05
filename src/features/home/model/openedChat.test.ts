import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { recentLines } from "./lines";
import { stampChat } from "./openedChat";

it("a slow open keeps the time it was asked, so a later fast open stays newer", () => {
  const slow = stampChat({ id: "a", title: "Slow" }, "crew", 100);
  const fast = stampChat({ id: "b", title: "Fast" }, "crew", 200);
  expect(recentLines([], [slow, fast]).map((line) => line.target)).toEqual(["b", "a"]);
  expect(stampChat({ id: "  ", title: "No" }, "crew", 1)).toBeNull();
});

it("the session open stamps the chat before the session finishes opening", () => {
  const src = readFileSync(new URL("../../../../src/app/App.tsx", import.meta.url), "utf8");
  const start = src.indexOf("const onSelectHistorySession = useCallback(");
  const end = src.indexOf("[appendTab,", start);
  const body = src.slice(start, end);
  expect(body).toContain("stampChat(");
  expect(body.indexOf("const askedAt = Date.now()")).toBeGreaterThan(-1);
  expect(body.indexOf("const askedAt = Date.now()")).toBeLessThan(body.indexOf("ensureOpenSession"));
  expect(body).not.toContain("openedAt: Date.now()");
  const opener = src.indexOf("useHomeOpener(");
  expect(opener).toBeGreaterThan(-1);
  expect(src.indexOf("setHomeOpener(")).toBe(-1);
});
