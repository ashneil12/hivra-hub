import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
import { FALLBACK_THEME, VISUAL_REPLY_MAX_BYTES } from "../model/visualReply";
import { readVisualTheme, VisualReplyFrame } from "./VisualReplyFrame";

function markdown(text: string, streaming?: boolean): string {
  return renderToStaticMarkup(
    createElement(AgentMarkdown, { text, streaming }),
  );
}

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
    expect(big).toContain("Save as file");
    expect(big).not.toContain("Allow network");
    expect(big).not.toContain("Show source");
  });

  it("starts on the visual, with the network off, and offers the source and a file", () => {
    const small = renderToStaticMarkup(
      createElement(VisualReplyFrame, { source: "<p>chart</p>" }),
    );
    expect(small).toContain("Show source");
    expect(small).not.toContain("Show visual");
    expect(small).toContain("Save as file");
    expect(small).toContain("Allow network");
    expect(small).toContain('aria-pressed="false"');
    expect(small).toContain("<iframe");
  });
});

describe("visual reply fences", () => {
  it("renders a marked fence and leaves ordinary html as markdown", () => {
    const visual = markdown("```visual\n<p>chart</p>\n```");
    expect(visual).toContain("<iframe");
    expect(visual).toContain('sandbox="allow-scripts"');
    expect(visual).not.toContain("allow-same-origin");

    const hinted = markdown("```html visual\n<p>chart</p>\n```");
    expect(hinted).toContain("<iframe");

    const plain = markdown("```html\n<p>chart</p>\n```");
    expect(plain).not.toContain("<iframe");
    expect(plain).toContain("markdown-code-shell");

    const extra = markdown("```html visual extra\n<p>chart</p>\n```");
    expect(extra).not.toContain("<iframe");

    const script = markdown("```javascript\n<p>chart</p>\n```");
    expect(script).not.toContain("<iframe");

    const prose = markdown("A paragraph with <p>chart</p> in the words.");
    expect(prose).not.toContain("<iframe");
  });

  it("keeps an unfinished visual fence as code", () => {
    const open = markdown("```visual\n<p>chart</p>", true);
    expect(open).not.toContain("<iframe");
  });

  it("renders two marked fences as two frames", () => {
    const both = markdown("```visual\n<p>one</p>\n```\n\n```visual\n<p>two</p>\n```");
    expect(both.match(/<iframe/g)).toHaveLength(2);
  });
});
