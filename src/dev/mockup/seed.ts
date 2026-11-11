// The design mockup (mockup.html, `npm run mockup:build`): the real app in a plain browser with every native call
// stubbed (browserTauriMock.ts) and this example dataset seeded first. Nothing is wired: replies come from the fake
// Claude, nothing reaches a disk, a CLI or the network. Example data only, never anyone's real chats (the repo is public).
//
// Runs before browserTauriMock.ts. It seeds once per SEED_VERSION, so a walk-through keeps what was clicked until the
// page's "Reset example" (`?reset`) or a newer seed.

import { EXAMPLE } from "./data";

const SEED_VERSION = "mockup-v2";
const SEEDED_KEY = "monocode:mockup-seeded";

const url = new URL(location.href);
const reset = url.searchParams.has("reset");

// browserTauriMock.ts reads these from the address: the local store (`local`) and the fake Claude (`fakeClaude`).
if (!url.searchParams.has("local") || !url.searchParams.has("fakeClaude") || reset) {
  url.searchParams.set("local", "");
  url.searchParams.set("fakeClaude", "");
  url.searchParams.delete("reset");
  history.replaceState(null, "", url.toString().replace(/=(?=&|$)/g, ""));
}

function seed(): void {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    return;
  }
  const now = Date.now();
  const set = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
  set("monocode:dev-local-hub:projects", { projects: EXAMPLE.projects });
  set("monocode:dev-roster-seed", EXAMPLE.roster());
  set("monocode:dev-sessions", EXAMPLE.sessions(now));
  set("monocode:dev-delegations", EXAMPLE.delegations(now));
  set("monocode:dev-decisions", EXAMPLE.decisions(now));
  set("monocode:pages", EXAMPLE.pages(now));
  set("monocode:dev-automations", EXAMPLE.automations(now));
  localStorage.setItem("monocode:hub-nav", JSON.stringify({ project: "", item: "home" }));
  localStorage.setItem(SEEDED_KEY, SEED_VERSION);
}

let seeded: string | null = null;
try {
  seeded = localStorage.getItem(SEEDED_KEY);
} catch {
  seeded = null;
}
if (reset || seeded !== SEED_VERSION) seed();

Object.assign(window, { __MONOCODE_MOCKUP__: true });

// Every chat's reply in the mockup. The app's own background turns (rounds, inbox counts) get a quiet line; anything
// typed gets a plain note that nothing here is wired.
Object.assign(window, {
  __fakeClaudeReply: (prompt: string): string => {
    // A message in a room (a project's own Chief of Staff chat, a team): an example answer from whoever hosts it.
    const room = /\[MonoCode room\] You are ([^,]+), in the group chat "[^"]*" \(room [^)]*\) for project "([^"]+)"/.exec(prompt);
    if (room)
      return `Example reply from ${room[1]}: got it. I'll hand this to the ${room[2]} lead and tell you here when it's done. (This is the mockup, so nothing really runs.)`;
    if (/From the app, not Ash|\[MonoCode /.test(prompt)) return "\n\nRight: nothing new since your last message.";
    return "This is the mockup, so nothing is wired: I can't do the work here. The screens and buttons are the real app's; tell Claude in the thread what you'd change about them.";
  },
});

// The walk-through always starts on Home, as the app does when it opens. The shell picks a project once its list loads,
// so Home is clicked until it has stayed in view for a couple of seconds (or the first 15 seconds are up).
const startedAt = Date.now();
let steady = 0;
const openHome = () => {
  if (Date.now() - startedAt > 15_000 || steady >= 8) return;
  if (document.querySelector("[data-home]")) steady += 1;
  else {
    steady = 0;
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hub-home] button"))
      .find((button) => button.textContent?.trim() === "Home")
      ?.click();
  }
  setTimeout(openHome, 300);
};
setTimeout(openHome, 500);
