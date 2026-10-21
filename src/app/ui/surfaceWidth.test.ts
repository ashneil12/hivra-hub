// Ash 21 Oct: Pages "and some other things" had "huge padding at either side ... take advantage of the extra screen real
// estate". The main surfaces fill the width with modest side padding; only long reading text (a chat message's body)
// keeps a line-length limit inside its own column (Critiquito). A centred, capped main column must not come back.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
/** A centred column with a narrow cap, the shape that left the big side gutters. */
const CAPPED = /mx-auto[^"`]*\bmax-w-(?:\d?xl|\[\d+px\])|\bmax-w-(?:\d?xl|\[\d+px\])[^"`]*mx-auto/;

const SURFACES: Record<string, string> = {
  Pages: "src/features/pages/ui/PagesView.tsx",
  "Today and project dashboards": "src/features/hub/ui/HubSurface.tsx",
  "Being built": "src/features/hub/ui/BeingBuiltView.tsx",
  Builds: "src/features/hub/ui/BuildsView.tsx",
  Inbox: "src/features/inbox/ui/InboxView.tsx",
  Notes: "src/features/notes/ui/NotesView.tsx",
  Automations: "src/features/automations/ui/AutomationsView.tsx",
  Settings: "src/features/settings/ui/SettingsView.tsx",
  "Mono status line": "src/features/hub/ui/RoomMessage.tsx",
};

describe("main surfaces fill the width", () => {
  for (const [name, file] of Object.entries(SURFACES)) {
    it(`${name} has no centred, capped main column`, () => {
      const capped = read(file).split("\n").filter((line) => CAPPED.test(line));
      expect(capped, file).toEqual([]);
    });
  }

  it("a chat room's column fills the width, and only a message's body keeps a reading limit", () => {
    const src = read("src/features/hub/ui/GroupChatView.tsx");
    const capped = src.split("\n").filter((line) => CAPPED.test(line));
    // The one capped column left is the small "New group chat" form, not the chat.
    expect(capped).toHaveLength(1);
    expect(src.slice(src.indexOf(capped[0]) - 400, src.indexOf(capped[0]))).toContain("New group chat");
    expect(src).toMatch(/<RoomText text=\{msg\.text\} className=\{`max-w-\[75ch\]/);
  });

  it("side padding is modest: 24px, 32px from xl", () => {
    const today = read("src/features/hub/ui/HubSurface.tsx");
    expect(today).toContain('className="flex w-full flex-col gap-6 px-6 py-8 xl:px-8" data-hub-surface-body');
    expect(read("src/features/pages/ui/PagesView.tsx")).toContain('className="w-full px-6 py-6 xl:px-8" data-pages-list');
  });

  it("Today and a project's dashboard put project sections side by side above about 1800px", () => {
    expect(read("src/features/hub/ui/HubSurface.tsx")).toContain('className="grid grid-cols-1 items-start gap-6 min-[1800px]:grid-cols-2 min-[1800px]:gap-x-12" data-hub-today-projects');
  });

  it("an ask's long title never widens Today past the window (Ash's Mac, 21 Oct: rows ran off the right edge)", () => {
    // A grid with no columns sizes its one column to the widest content, and a one-line (truncated) title is as wide as
    // all its words, so the rows ran off the window, cut without an ellipsis. One shrinkable column, below 1800px too.
    const today = read("src/features/hub/ui/HubSurface.tsx");
    const grid = today.split("\n").find((line) => line.includes("data-hub-today-projects>"))!;
    expect(grid).toMatch(/className="grid grid-cols-1\b/);
  });

  it("a Page preview has no diagonal Preview watermark: the bar under it says it is a preview", () => {
    const pages = read("src/features/pages/ui/PagesView.tsx");
    expect(pages).not.toMatch(/-rotate-12[^"]*">Preview</);
    expect(pages).toContain("This is a preview. Nothing is saved until you apply it.");
  });
});
