import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvents } from "../../../integrations/harness/core/apply";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { newSession, type Session } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

/**
 * The reply appears as it is written, in a Mono's chat too (the hub's own chat). Replayed over a recorded Claude
 * Code 2.1.302 transcript: every line the CLI printed is fed back through the child-process seam, and the chat is
 * rendered at the moment the first reply text lands, before the turn's result.
 */

const lines: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    _exit: (code?: number | null) => void,
  ) => {
    onLine = line;
  },
  writeChild: vi.fn(async () => undefined),
}));

// Loaded after `vi.mock` so the adapter sees the faked child seam.
const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import(
  "../../../integrations/harness/providers/claude/claude"
);

const RECORDED = readFileSync(
  new URL(
    "../../../integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/workflow-run.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim());

/** The chat as a person sees it, with the markup's tags and word spans taken out. */
function shown(events: readonly HarnessEvent[]): string {
  let session: Session = {
    ...newSession("claude", "/repo"),
    blocks: [{ id: "u1", role: "user", text: "Run the workflow" }],
  };
  session = applyHarnessEvents(session, events);
  return renderToStaticMarkup(
    createElement(AgentTranscript, {
      blocks: session.blocks,
      busy: true,
      inlineWork: true,
    }),
  )
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
}

beforeEach(async () => {
  await stopClaudeSession("chat");
  lines.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

describe("a Mono chat while the reply is written", () => {
  it("shows the reply text as soon as the provider streams it, before the turn ends", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "chat",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "full-access",
      text: "Run the workflow",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    turn.catch(() => undefined);
    for (let i = 0; i < 400 && !onLine; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    let atFirstText = -1;
    for (const line of RECORDED) {
      onLine!(line);
      if (atFirstText < 0 && events.some((e) => e.type === "message.delta")) {
        atFirstText = events.length;
        break;
      }
    }
    expect(atFirstText).toBeGreaterThan(0);
    // The turn has not ended: no result line has been read yet.
    expect(events.some((e) => e.type === "turn.ready")).toBe(false);
    expect(shown(events)).toContain("Workflow started.");
  });
});
