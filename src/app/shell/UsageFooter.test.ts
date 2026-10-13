import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageFooter } from "./UsageFooter";

describe("UsageFooter terminal control", () => {
  it("replaces the generic terminal button with the live process control", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        terminals: [
          {
            id: "terminal-1",
            process: "npm",
            cwd: "/repo",
            label: "repo",
          },
        ],
        terminalOpen: true,
        onToggleTerminal: vi.fn(),
        onNewTerminal: vi.fn(),
        onShowTerminal: vi.fn(),
        projectTerminalActive: true,
      }),
    );

    expect(markup).toContain(">npm</span>");
    expect(markup).not.toContain(">Terminal</span>");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the generic terminal button when no process is running", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageFooter, {
        providers: [],
        onNewTerminal: vi.fn(),
      }),
    );

    expect(markup).toContain(">Terminal</span>");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });
});

describe("CC Studio usage footer", () => {
  it.each([
    ["claude:ccstudio:deepseek:deepseek-chat", "DeepSeek API"],
    ["claude:ccstudio:opencode-go:deepseek-v4.1-flash", "OpenCode Go"],
  ])("shows the actual upstream for %s instead of Anthropic subscription usage", (model, label) => {
    const markup = renderToStaticMarkup(createElement(UsageFooter, {
      providers: ["claude"],
      session: { harness: "claude", model, authRequired: true },
    }));
    expect(markup).toContain(`>${label}</span>`);
    expect(markup).not.toContain("Sign in");
    expect(markup).not.toContain("Max");
  });
});
