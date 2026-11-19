import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessIcon } from "./HarnessIcon";

describe("the model line's mark (Critiquito, 29 Oct: no orange star)", () => {
  it("draws the Claude mark grey when asked, and in colour otherwise", () => {
    const grey = renderToStaticMarkup(createElement(HarnessIcon, { harness: "claude", mono: true }));
    expect(grey).toContain("grayscale");
    const colour = renderToStaticMarkup(createElement(HarnessIcon, { harness: "claude" }));
    expect(colour).not.toContain("grayscale");
  });
});
