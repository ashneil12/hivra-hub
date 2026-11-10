// WP-130 review, item 3: every window message listener that acts on a frame's message must check where the message came
// from. That check (`event.source`) is the barrier. An origin check cannot be used here: a sandboxed frame has an opaque
// origin, so the source is the only thing that ties a message to its frame.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LISTENER_FILES = [
  "src/features/artifacts/ui/HtmlArtifactFrame.tsx",
  "src/features/pages/ui/PagesView.tsx",
  "src/features/panels/ui/PanelTabs.tsx",
  "src/features/sessions/ui/VisualReplyFrame.tsx",
];

const SOURCE_CHECK = /(event|e)\.source\s*!==\s*[\w.?]+|(event|e)\.source\s*===\s*[\w.?]+/;

describe("window message listeners for frames check the message source", () => {
  for (const file of LISTENER_FILES) {
    it(`${file} checks event.source before it acts on a message`, () => {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      const listeners = [...text.matchAll(/addEventListener\("message",/g)];
      expect(listeners.length).toBeGreaterThan(0);
      for (const match of listeners) {
        // The handler is defined just above its addEventListener call.
        const before = text.slice(Math.max(0, match.index! - 1500), match.index);
        expect(before).toMatch(SOURCE_CHECK);
      }
    });
  }
});
