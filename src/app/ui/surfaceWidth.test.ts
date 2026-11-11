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
  "Project home": "src/features/hub/ui/HubSurface.tsx",
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

  it("a Mono's 1:1 fills the width like a room: transcript, composer, tool cards and code blocks (Critiquito 22 Oct)", () => {
    const transcript = read("src/features/sessions/ui/AgentTranscript.tsx");
    // The Mono (bottom-aligned) column: no centred cap, the room's side padding with the rows' own px-4.
    const mono = transcript.split("\n").find((line) => line.includes(`className="chat-reading-limit`))!;
    expect(mono).toBeDefined();
    expect(mono).not.toMatch(CAPPED);
    expect(mono).not.toMatch(/\bmax-w-/);
    expect(mono).toMatch(/\bw-full\b.*\bpx-2\b.*\bxl:px-4\b/);
    // The composer, in the 1:1 and in a room, is never a centred capped box; the 1:1 dock uses the room's padding.
    expect(read("src/features/monos/ui/MonoComposer.tsx").split("\n").filter((line) => CAPPED.test(line))).toEqual([]);
    const pane = read("src/features/sessions/ui/SessionPane.tsx");
    // Dropwave (Ash 11 Nov): where every chat has one look, a first mate's chat takes the general chat's box instead.
    expect(pane).toContain("const monoBox = !!agent && !ONE_CHAT_LOOK;");
    expect(pane).toContain('className={monoBox ? "w-full shrink-0 px-6 xl:px-8" : "mx-auto w-full max-w-4xl shrink-0"}');
    expect(read("src/features/hub/ui/GroupChatView.tsx")).toContain('<div className="w-full shrink-0 px-6 pb-3 xl:px-8">');
    // A worker's delegated-chat card and its stuck card fill too (they capped at 768px).
    const notices = read("src/features/monos/ui/DelegationNotices.tsx");
    expect(notices.split("\n").filter((line) => CAPPED.test(line))).toEqual([]);
    expect(notices).not.toMatch(/max-w-3xl/);
  });

  it("in a Mono's 1:1 only the plain reply text keeps the room's 75ch reading limit, never code blocks or tables", () => {
    const css = read("src/styles/index.css");
    const rule = css.match(/\.chat-reading-limit[^{]*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("max-width: 75ch");
    expect(rule).toContain('[data-chat-message-role="assistant"] .agent-markdown :is(p, li,');
    expect(rule).not.toMatch(/pre|code|table/);
    // The same limit a room's message body uses, so both kinds of chat read alike.
    expect(read("src/features/hub/ui/GroupChatView.tsx")).toMatch(/<RoomText text=\{msg\.text\} className=\{`max-w-\[75ch\]/);
  });

  it("side padding is modest: 24px, 32px from xl", () => {
    expect(read("src/features/pages/ui/PagesView.tsx")).toContain('className="w-full px-6 pt-5 pb-10 xl:px-8" data-pages-list');
  });

  it("a Page preview has no diagonal Preview watermark: the bar under it says it is a preview", () => {
    const pages = read("src/features/pages/ui/PagesView.tsx");
    expect(pages).not.toMatch(/-rotate-12[^"]*">Preview</);
    expect(pages).toContain("This is a preview. Nothing is saved until you apply it.");
  });
});
