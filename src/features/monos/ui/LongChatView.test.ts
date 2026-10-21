// @vitest-environment happy-dom
// "we said fridays for the review right?" is a test line written in Ash's style, not something Ash said.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app")) }));
import { earlierLabel, LongChatLines } from "./LongChatView";

it("names a folded line by how many messages it stands for, never UniiChat's 8x", () => {
  const html = renderToStaticMarkup(
    createElement(LongChatLines, {
      lines: [
        { id: 0, n: 8, text: "user: keep the review async; mono: got it" },
        { id: 8, n: 1, text: "user: we said fridays for the review right?" },
      ],
      zoom: async () => [],
    }),
  );
  expect(html).toContain("8 earlier messages");
  expect(html).toContain("Ash: we said fridays for the review right?");
  expect(html).not.toMatch(/\d+x\b|·\s*fold|▾/);
  expect(earlierLabel(1)).toBe("1 earlier message");
});
