// Dev only (hub-dev.html): what a Mono's mono_create, page_build and hub_change calls do, reachable from a browser
// proof (`window.__devSelfBuild`). The hub-code commands are stand-ins for self_build.rs (no git in a browser): the
// change bar, the Pages preview and the Bot changes rows are the app's own. Never shipped: only browserTauriMock loads it.
import { botChangeRows, flowChanges, undoBotChange } from "../features/hub/model/botChanges";
import { readyHubChange, setHubCodeCommands, startHubChange, undoHubPart } from "../features/selfBuild/model/hubCode";
import { draftMono } from "../features/selfBuild/model/monoMake";
import { openChatPreview, previewFromChat } from "../features/selfBuild/model/pagesChat";

const commits = [
  { sha: "a1b2c3d", subject: "New chat button is at the top", files: ["src/app/shell/Sidebar.tsx"] },
  { sha: "e4f5a6b", subject: "Accent is a bit more purple", files: ["src/styles/theme.css"] },
];
let reverts = 0;
setHubCodeCommands({
  prepare: async (id) => ({ id, folder: `/Users/ash/Library/Application Support/MonoCode Hub/self-build/${id}`, base: "a0f86920" }),
  collect: async () => ({ commits, blocked: [] }),
  preview: async () => undefined,
  apply: async () => commits.map(({ sha, subject }) => ({ sha, subject })),
  discard: async () => undefined,
  revert: async (sha) => `${sha.slice(0, 3)}r${(reverts += 1)}`,
  ping: async () => undefined,
  live: async () => null,
});

Object.assign(window, {
  __devSelfBuild: { draftMono, previewFromChat, openChatPreview, startHubChange, readyHubChange, undoHubPart, undoBotChange, flowChanges, botChangeRows },
});
