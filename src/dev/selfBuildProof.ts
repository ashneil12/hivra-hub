// Dev only (hub-dev.html): what a Mono's mono_create, page_build and hub_change calls do, reachable from a browser
// proof (`window.__devSelfBuild`). The hub-code commands are stand-ins for self_build.rs (no git in a browser): the
// change bar, the Pages preview and the Bot changes rows are the app's own. Never shipped: only browserTauriMock loads it.
import {
  botChangeRows,
  flowChanges,
  undoBotChange,
} from "../features/hub/model/botChanges";
import {
  readyHubChange,
  setHubCodeCommands,
  startHubChange,
  undoHubPart,
} from "../features/selfBuild/model/hubCode";
import { draftMono } from "../features/selfBuild/model/monoMake";
import {
  openChatPreview,
  previewFromChat,
} from "../features/selfBuild/model/pagesChat";

const commits = [
  {
    sha: "a1b2c3d",
    subject: "New chat button is at the top",
    files: ["src/app/shell/Sidebar.tsx"],
  },
  {
    sha: "e4f5a6b",
    subject: "Accent is a bit more purple",
    files: ["src/styles/theme.css"],
  },
];
// What each commit does to the screen, standing in for Vite's hot reload of the patched files: the group chat's
// conversations (with its New conversation button) move to the top of the panel, and the accent goes purple.
const LOOK: Record<string, string> = {
  a1b2c3d:
    "[data-hub-chat] div:has(> div > [data-hub-new-conversation]) { order: -1; padding-top: 8px; }",
  e4f5a6b:
    // Something you notice at a glance: the selected row, the send button and the new chat button go purple.
    ":root { --scheme-accent: hsl(268 85% 72%); } [data-hub-new-conversation] { color: hsl(268 85% 72%); } " +
    "[data-hub-item].bg-selection, [data-mono-rail] [data-selected] { background-color: hsl(268 85% 72% / 0.28) !important; box-shadow: inset 2px 0 0 hsl(268 85% 72%); } " +
    'button[aria-label="Send"] { background-color: hsl(268 85% 62%) !important; color: white !important; opacity: 1 !important; }',
};
const showing = new Set<string>();
const paint = () => {
  let style = document.querySelector<HTMLStyleElement>(
    "style[data-dev-hub-change]",
  );
  if (!style) {
    style = document.createElement("style");
    style.dataset.devHubChange = "";
  }
  style.setAttribute("data-dev-hub-change", "");
  style.textContent = [...showing].map((sha) => LOOK[sha]).join("\n");
  document.head.append(style);
};
const reverted = new Map<string, string>();
let reverts = 0;
setHubCodeCommands({
  prepare: async (id) => ({
    id,
    folder: `/Users/ash/Library/Application Support/MonoCode Hub/self-build/${id}`,
    base: "a0f86920",
  }),
  collect: async () => ({ commits, blocked: [] }),
  preview: async (_id, on) => {
    for (const c of commits) on ? showing.add(c.sha) : showing.delete(c.sha);
    paint();
  },
  apply: async () => {
    for (const c of commits) showing.add(c.sha);
    paint();
    return commits.map(({ sha, subject }) => ({ sha, subject }));
  },
  discard: async () => {
    showing.clear();
    paint();
  },
  // Undo takes one commit's look out; Redo (reverting the revert) puts it back.
  revert: async (sha) => {
    const back = reverted.get(sha);
    if (back) {
      showing.add(back);
      reverted.delete(sha);
    } else showing.delete(sha);
    const id = `${sha.slice(0, 3)}r${(reverts += 1)}`;
    if (!back) reverted.set(id, sha);
    paint();
    return id;
  },
  ping: async () => undefined,
  live: async () => null,
});

Object.assign(window, {
  // `skills`: names installed on Ash's Mac (~/.claude/skills), since this page has no skill folders of its own.
  __devSelfBuild: {
    draftMono: (
      input: Record<string, unknown>,
      me: Parameters<typeof draftMono>[1],
      skills: string[],
    ) => draftMono(input, me, Date.now(), new Set(skills)),
    previewFromChat,
    openChatPreview,
    startHubChange,
    readyHubChange,
    undoHubPart,
    undoBotChange,
    flowChanges,
    botChangeRows,
  },
});
