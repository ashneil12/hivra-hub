// @vitest-environment happy-dom
// Review of PR #244, round 4 (WP-215). Red on 8b093753b.
import { beforeEach, describe, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { gateLog, noteChats, resetWaitingChats, setCaptainDoor, setWaitingChatsHost, takePick } from "./waitingChats";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/Users/someone/Projects/vg-game" },
];

type Chat = Parameters<typeof noteChats>[0][number];
const markerChat = (id: string, text: string): Chat => ({
  id,
  cwd: "/Users/someone/Projects/vg-game",
  title: "claude · Files",
  harness: "claude",
  blocks: [
    { role: "user", text: "go", startedAt: 1 },
    { role: "assistant", text },
  ],
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  resetWaitingChats();
  setCaptainDoor(null);
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWaitingChatsHost({
    liveQuestion: () => undefined,
    respond: () => undefined,
    send: async () => true,
    open: () => undefined,
  });
});

describe("the waiting-chat captain door (review of PR #244, round 4)", () => {
  it("does not record a chat's own pick as the captain's answer when nobody marked it confident", async () => {
    // What appCaptainDoor (autopilotApp.ts) returns since round 4: no `confident`, money under the limit, no rule,
    // no standing answer, no learned row. useAutopilot installs that door. takePick reads a missing flag as confident
    // (`extra.confident !== false`), so step 5 records the chat's own pick as `captain:<chief>`.
    setCaptainDoor(() => ({
      rules: [],
      standing: null,
      learned: null,
      moneyOverLimit: false,
      monoId: "ada",
      department: "The first mate",
    }));
    noteChats([markerChat("own-pick", "Needs Ash: Rename the file?\nMy pick: yes")]);
    await takePick("own-pick", { by: "autopilot" });
    const who = gateLog().find((row) => row.sessionId === "own-pick")?.answer?.who ?? "";
    expect(who.startsWith("captain:"), who).toBe(false);
  });
});
