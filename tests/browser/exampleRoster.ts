// WP-05: browser proofs that used to lean on the built-in team seed their own Monos.
// The four leads keep the looks those proofs check, because no project ships with a look of its own.
import type { Page } from "@playwright/test";

const FOLDERS = [
  "/Users/example/Projects/vg-game",
  "/Users/example/Projects/hivra",
  "/Users/example/Projects/nibbii",
  "/Users/example/Projects/monocode-hub",
];

export const EXAMPLE_ROSTER = [
  { id: "ada", name: "Ada", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", role: "Keeps the week moving", engine: "claude", projects: FOLDERS },
  { id: "bo", name: "Bo", mascot: "robot", color: "hsl(210 8% 58%)", role: "Keeps the board", engine: "claude", projects: FOLDERS },
  { id: "ed", name: "ed", mascot: "robot", color: "hsl(210 8% 58%)", role: "Checks what was said", engine: "claude", projects: FOLDERS },
  { id: "cam", name: "Cam", mascot: "robot", color: "hsl(210 8% 58%)", role: "One owner per job", engine: "claude", projects: FOLDERS },
  { id: "vg-game-lead", name: "EXO lead", mascot: "invader", color: "hsl(211 92% 62%)", engine: "claude", projects: [FOLDERS[0]] },
  { id: "hivra-lead", name: "Hivra lead", mascot: "dino", color: "hsl(12 80% 58%)", engine: "claude", projects: [FOLDERS[1]] },
  { id: "nibbii-lead", name: "Nibbii lead", mascot: "robot", color: "hsl(45 90% 55%)", engine: "claude", projects: [FOLDERS[2]] },
  { id: "hub-lead", name: "MonoCode Hub lead", mascot: "cat", color: "hsl(142 55% 50%)", engine: "claude", projects: [FOLDERS[3]] },
];

/** EXO's leadership room, with Ada in it, so New conversation has a member to show. */
const LEADERSHIP_ROOM = {
  id: "vg-game:leadership",
  projectId: "vg-game",
  name: "Leadership team",
  isDefault: true,
  memberIds: ["ada"],
  leadId: "ada",
  seated: true,
  conversations: [],
};

/** The roster the browser mock copies in, and the leadership room when the page has not saved one yet. */
export function seedExampleRoster(page: Page): Promise<void> {
  return page.addInitScript(({ roster, room }) => {
    localStorage.setItem("monocode:dev-roster-seed", JSON.stringify(roster));
    const key = "monocode:hub-chats";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([room]));
    // A Mono left open would cover the hub after a reload. These proofs come back to a project view.
    localStorage.removeItem("monocode:open-mono");
  }, { roster: EXAMPLE_ROSTER, room: LEADERSHIP_ROOM });
}
