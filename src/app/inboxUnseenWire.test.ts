import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("passes the inbox tracker's unseen flag into the sidebar dot", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(src.includes("inboxUnseen={false}")).toBe(false);
  expect(/unseen:\s*inboxUnseen/.test(src)).toBe(true);
  expect(src.includes("inboxUnseen={inboxUnseen}")).toBe(true);
});
