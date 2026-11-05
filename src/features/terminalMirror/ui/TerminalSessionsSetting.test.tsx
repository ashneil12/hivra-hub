import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => new Promise(() => undefined)),
}));

import { TerminalSessionsSetting } from "./TerminalSessionsSetting";

describe("the terminal sessions setting", () => {
  it("is off, and named in plain words, before anything is known", () => {
    const html = renderToStaticMarkup(createElement(TerminalSessionsSetting));
    expect(html).toContain("Show my terminal Claude sessions");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("Turn it on");
  });
});
