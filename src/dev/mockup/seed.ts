// The design mockup (mockup.html, `npm run mockup:build`): the real app in a plain browser with every native call
// stubbed (browserTauriMock.ts) and this example dataset seeded first. Nothing is wired: replies come from the fake
// Claude, nothing reaches a disk, a CLI or the network. Example data only, never anyone's real chats (the repo is public).
//
// Runs before browserTauriMock.ts. It seeds once per SEED_VERSION, so a walk-through keeps what was clicked until the
// page's "Reset example" (`?reset`) or a newer seed.

import { EXAMPLE } from "./data";

const SEED_VERSION = "mockup-v3";
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
  set("monocode:hub-chats", EXAMPLE.rooms());
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

// A council in the mockup: every seat answers with an example, the third one disagrees, and the chair writes an example
// verdict, so asking a question ends in a decision with a minority. Nothing is sent anywhere.
// Loaded only after the example data is in place: the council's modules read the rooms as they load.
const councilSeats = new Map<string, number>();
void import("../../features/council/model/host").then(({ setCouncilModel }) => setCouncilModel(async ({ seatId, round, signal }) => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (signal.aborted) throw new DOMException("The council was stopped.", "AbortError");
  if (!councilSeats.has(seatId)) councilSeats.set(seatId, councilSeats.size);
  const dissents = (councilSeats.get(seatId) ?? 0) % 3 === 2;
  if (round === "verdict")
    return {
      text: [
        "UNRESOLVED:",
        "Example: nobody has checked the thank-you email on a real phone yet.",
        "KILL CRITERIA:",
        "Example: stop if the sign-up form fails on phones the day before.",
        "NEXT STEP:",
        "Example: go ahead, and test the sign-up form on two phones first.",
        "MINORITY REPORT:",
        "Example: one seat would wait a week for a tested thank-you email.",
      ].join("\n"),
    };
  if (round === "stance")
    return {
      text: dissents
        ? "Example: a week buys a tested thank-you email.\nSTANCE: wait a week | CONFIDENCE: med | DEALBREAKER: no"
        : "Example: it is ready, and waiting costs sign-ups.\nSTANCE: go ahead | CONFIDENCE: high | DEALBREAKER: no",
    };
  if (round === "cross")
    return { text: dissents ? "Example: I still think a short delay is cheaper than a broken first impression." : "Example: I disagree most with the seat that wants to wait: the email can follow a day later." };
  return { text: dissents ? "Example: the risk is the thank-you email. I'd wait until it is tested." : "Example: the page works and the list is warm. I'd go ahead." };
}));

// Every chat's reply in the mockup. The app's own background turns (rounds, inbox counts) get a quiet line; anything
// typed gets a plain note that nothing here is wired.
Object.assign(window, {
  __fakeClaudeReply: (prompt: string): string => {
    // A message in a room (a project's own Chief of Staff chat, a team): an example answer from whoever hosts it.
    const room = /\[MonoCode room\] You are ([^,]+), in the group chat "[^"]*" \(room [^)]*\) for project "([^"]+)"/.exec(prompt);
    if (room)
      return `Example reply from ${room[1]}: got it. I'll hand this to the ${room[2]} lead and tell you here when it's done. (This is the mockup, so nothing really runs.)`;
    // What Ash typed in a one-to-one chat: what is left once the app's own context and notes are taken out.
    const typed = prompt
      .replace(/<monocode_context>[\s\S]*?<\/monocode_context>/g, "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith("[MonoCode ") && !part.startsWith("Note: MonoCode"))
      .join(" ");
    const me = /^- (.+?) \(you\)/m.exec(prompt)?.[1];
    if (typed && me)
      return `Example reply from ${me}: got it. I'll take it from here and tell you in this chat when it's done. (This is the mockup, so nothing really runs.)`;
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
