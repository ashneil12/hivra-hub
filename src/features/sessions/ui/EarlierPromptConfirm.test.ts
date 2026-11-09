import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EarlierPromptConfirm } from "./EarlierPromptConfirm";

describe("EarlierPromptConfirm", () => {
  it("says later replies belong to the earlier prompt, and offers both choices", () => {
    const html = renderToStaticMarkup(
      createElement(EarlierPromptConfirm, { open: true, onKeep: vi.fn(), onRemove: vi.fn() }),
    );
    expect(html).toContain("Later replies belong to the earlier prompt. Remove them and send this instead?");
    expect(html).toContain("Keep later replies");
    expect(html).toContain("Remove and send");
    expect(html).toContain('role="dialog"');
  });

  it("renders nothing until a confirm is needed", () => {
    const html = renderToStaticMarkup(
      createElement(EarlierPromptConfirm, { open: false, onKeep: vi.fn(), onRemove: vi.fn() }),
    );
    expect(html).toBe("");
  });
});
