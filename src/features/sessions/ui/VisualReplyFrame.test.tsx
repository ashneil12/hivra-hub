import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FALLBACK_THEME, VISUAL_REPLY_MAX_BYTES } from "../model/visualReply";
import { readVisualTheme, VisualReplyFrame } from "./VisualReplyFrame";

describe("visual reply frame", () => {
  it("uses the fallback theme when there is no page", () => {
    expect(readVisualTheme()).toEqual(FALLBACK_THEME);
  });

  it("frames a reply and shows the source when the reply is too big", () => {
    const small = renderToStaticMarkup(
      createElement(VisualReplyFrame, { source: "<p>chart</p>" }),
    );
    expect(small).toContain('sandbox="allow-scripts"');
    expect(small).not.toContain("allow-same-origin");
    expect(small).toContain("--hivra-background:#111111");

    const big = renderToStaticMarkup(
      createElement(VisualReplyFrame, { source: "a".repeat(VISUAL_REPLY_MAX_BYTES + 1) }),
    );
    expect(big).toContain("This reply is too big to show here.");
    expect(big).not.toContain("<iframe");
    expect(big).toContain("a".repeat(32));
  });
});
