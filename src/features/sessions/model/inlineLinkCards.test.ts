import { afterEach, expect, it } from "vitest";
import { hasInlineLinkCard, inlineLinkCard, setInlineLinkCard } from "./inlineLinkCards";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

it("asks the lent renderer only about local hivra links", () => {
  const asked: string[] = [];
  release = setInlineLinkCard((href) => {
    asked.push(href);
    return href.includes("/need/") ? "card" : undefined;
  });
  expect(inlineLinkCard("hivra://local/need/a", "A")).toBe("card");
  expect(inlineLinkCard("hivra://local/chat/a", "A")).toBeUndefined();
  expect(inlineLinkCard("https://example.com/need/a", "A")).toBeUndefined();
  expect(inlineLinkCard(undefined, "A")).toBeUndefined();
  expect(hasInlineLinkCard("hivra://local/need/a")).toBe(true);
  expect(asked.every((href) => href.startsWith("hivra://local/"))).toBe(true);
});

it("draws nothing once the renderer is taken back, or when it throws", () => {
  release = setInlineLinkCard(() => "card");
  release();
  release = undefined;
  expect(inlineLinkCard("hivra://local/need/a", "A")).toBeUndefined();
  release = setInlineLinkCard(() => {
    throw new Error("Example: broken");
  });
  expect(inlineLinkCard("hivra://local/need/a", "A")).toBeUndefined();
});
