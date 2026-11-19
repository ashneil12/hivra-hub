import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
import { FALLBACK_THEME, VISUAL_REPLY_MAX_BYTES } from "../model/visualReply";
import { readVisualTheme, VisualReplyFrame } from "./VisualReplyFrame";

function markdown(
  text: string,
  options: { streaming?: boolean; visualReplies?: boolean } = {},
): string {
  return renderToStaticMarkup(createElement(AgentMarkdown, { text, ...options }));
}

describe("visual reply frame", () => {
  it("uses the fallback theme when there is no page", () => {
    expect(readVisualTheme()).toEqual(FALLBACK_THEME);
  });

  it("frames a reply and shows the source when the reply is too big", () => {
    const small = renderToStaticMarkup(
      createElement(VisualReplyFrame, { source: "<p>chart</p>", autoRun: true }),
    );
    expect(small).toContain('sandbox="allow-scripts"');
    expect(small).not.toContain("allow-same-origin");
    expect(small).toContain("--hivra-background:#111111");

    const big = renderToStaticMarkup(
      createElement(VisualReplyFrame, {
        source: "a".repeat(VISUAL_REPLY_MAX_BYTES + 1),
        autoRun: true,
      }),
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
      createElement(VisualReplyFrame, { source: "<p>chart</p>", autoRun: true }),
    );
    expect(small).toContain("Show source");
    expect(small).not.toContain("Show visual");
    expect(small).toContain("Save as file");
    expect(small).toContain("Allow network");
    expect(small).toContain('aria-pressed="false"');
    expect(small).toContain("<iframe");
  });

  it("a reply that was not run waits for the person: source and a button, no frame", () => {
    const waiting = renderToStaticMarkup(
      createElement(VisualReplyFrame, { source: "<p>chart</p>" }),
    );
    expect(waiting).not.toContain("<iframe");
    expect(waiting).toContain("Run visual reply");
    expect(waiting).toContain("&lt;p&gt;chart&lt;/p&gt;");
    expect(waiting).toContain("Save as file");
    expect(waiting).not.toContain("Allow network");
  });
});

// WP-130 review, item 1: a visual fence is for the agent's own reply only. Every other Markdown surface shows the
// fence as plain code, so a PR body or comment written by someone else never frames script.
const VISUAL_FENCE = "Notes:\n\n```visual\n<script>fetch('https://example.invalid/x')</script>\n```";

describe("visual reply fences", () => {
  it("renders a marked fence in an agent reply that streamed, and leaves ordinary html as markdown", () => {
    // A closed fence with prose after it is complete; the last block is still streaming, so it stays code.
    const visual = markdown("```visual\n<p>chart</p>\n```\n\nDone.", { visualReplies: true, streaming: true });
    expect(visual).toContain("<iframe");
    expect(visual).toContain('sandbox="allow-scripts"');
    expect(visual).not.toContain("allow-same-origin");

    const hinted = markdown("```html visual\n<p>chart</p>\n```\n\nDone.", { visualReplies: true, streaming: true });
    expect(hinted).toContain("<iframe");

    const plain = markdown("```html\n<p>chart</p>\n```", { visualReplies: true, streaming: true });
    expect(plain).not.toContain("<iframe");
    expect(plain).toContain("markdown-code-shell");

    const extra = markdown("```html visual extra\n<p>chart</p>\n```", { visualReplies: true, streaming: true });
    expect(extra).not.toContain("<iframe");

    const script = markdown("```javascript\n<p>chart</p>\n```", { visualReplies: true, streaming: true });
    expect(script).not.toContain("<iframe");

    const prose = markdown("A paragraph with <p>chart</p> in the words.", { visualReplies: true, streaming: true });
    expect(prose).not.toContain("<iframe");
  });

  it("keeps an unfinished visual fence as code", () => {
    const open = markdown("```visual\n<p>chart</p>", { visualReplies: true, streaming: true });
    expect(open).not.toContain("<iframe");
  });

  it("renders two marked fences as two frames", () => {
    const both = markdown("```visual\n<p>one</p>\n```\n\n```visual\n<p>two</p>\n```\n\nDone.", {
      visualReplies: true,
      streaming: true,
    });
    expect(both.match(/<iframe/g)).toHaveLength(2);
  });

  it("a reply loaded from history shows a run button and no frame until the person runs it", () => {
    const restored = markdown("```visual\n<p>chart</p>\n```", { visualReplies: true });
    expect(restored).not.toContain("<iframe");
    expect(restored).toContain("Run visual reply");
  });

  it("a PR body with a visual fence renders no frame", () => {
    const body = renderToStaticMarkup(
      createElement(AgentMarkdown, { text: VISUAL_FENCE, cwd: "/work/repo", allowRemoteMedia: true }),
    );
    expect(body).not.toContain("<iframe");
    expect(body).not.toContain("data-visual-reply-frame");
    expect(body).not.toContain("Run visual reply");
    expect(body).toContain("markdown-code-shell");
  });

  it("a PR or issue comment with a visual fence renders no frame", () => {
    const comment = renderToStaticMarkup(
      createElement(AgentMarkdown, { text: VISUAL_FENCE, cwd: "/work/repo" }),
    );
    expect(comment).not.toContain("<iframe");
    expect(comment).not.toContain("data-visual-reply-frame");
    expect(comment).toContain("markdown-code-shell");
  });

  it("notes, artifacts, reasoning and subagent reports show a visual fence as code", () => {
    const surfaces = [
      { hardBreaks: true, cwd: "/work/repo" },
      { cwd: "/work/repo", streaming: false },
      { className: "agent-reasoning" },
      {},
    ];
    for (const props of surfaces) {
      const html = renderToStaticMarkup(
        createElement(AgentMarkdown, { text: VISUAL_FENCE, ...props }),
      );
      expect(html, JSON.stringify(props)).not.toContain("<iframe");
      expect(html, JSON.stringify(props)).toContain("markdown-code-shell");
    }
  });
});
