// @vitest-environment happy-dom
// r51 (Alfred's r50 blind run, e02): ed's room message ended with the raw word NO_REPLY. It is the app's signal for
// "say nothing", never words for Ash: it is dropped from a saved post and a live draft, and from a message that was
// saved with it before, when it renders.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanPost, isSilent } from "../model/roomTurns";
import { RoomText } from "./RoomMessage";

const FRANK = "CoS treated \"Ye go\" as not a lock. I'm checking Hub memory so a test doesn't sit there as a decision.\n\nNO_REPLY";

describe("NO_REPLY never shows in a room (r51)", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a post or live draft is saved without it", () => {
    expect(cleanPost(FRANK, "ed")).not.toMatch(/NO_REPLY/i);
    expect(cleanPost("ed: Done here. NO_REPLY", "ed")).toBe("Done here.");
    expect(isSilent("NO_REPLY")).toBe(true);
  });

  it("a message saved with it renders without it", () => {
    act(() => root.render(createElement(RoomText, { text: FRANK })));
    expect(container.textContent).toContain("as a decision.");
    expect(container.textContent).not.toMatch(/NO_REPLY/i);
  });
});
