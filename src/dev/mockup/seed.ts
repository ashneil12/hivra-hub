// The design mockup (mockup.html, `npm run mockup:build`): the real app in a plain browser with every native call
// stubbed (browserTauriMock.ts) and this example dataset seeded first. Nothing is wired: replies come from the fake
// Claude, nothing reaches a disk, a CLI or the network. Example data only, never anyone's real chats (the repo is public).
//
// Runs before browserTauriMock.ts. It seeds once per SEED_VERSION, so a walk-through keeps what was clicked until the
// page's "Reset example" (`?reset`) or a newer seed.

import { EXAMPLE } from "./data";
import { mockupIpc, seedMockupIpc } from "./ipc";
import { addAsked, setDirection, type Asked, type Direction } from "../../features/asks/model/askLedger";

// One main Chief of Staff chat (13 Nov): an example long message with seven asks in it, and the receipt for it.
const RANT =
  "Example: ok so the more I look at this the more I want the main chat back, like the pinned one with Chief of Staff, we had that and it was good so bring it back. and if I want to start a side chat I can, and jump into one when I need to take over. but before anyone builds anything I want to see a mock-up of one chat running like ten projects, because I honestly don't know how it should look yet. also all those memory and design repos I sent, actually copy each one and read it properly, not a glance, you never know what gems are in there. use the strongest model for those. oh and the Nibbii onboarding copy still sounds robotic, fix that. and that storage thing on the Mac again, sort it.";
const RECEIPT: Asked[] = [
  { id: "rant-1", text: "Bring back the pinned main chat with the Chief of Staff", where: "Hivra lead", state: "working" },
  { id: "rant-2", text: "Side chats I can start, and jump into to take over", where: "Hivra lead, same job as 1", state: "working" },
  { id: "rant-3", text: "A mock-up of one chat running ten projects, before anyone builds", where: "Iris, design review", state: "working" },
  { id: "rant-4", text: "Copy and properly read every memory and design repo", where: "Hivra lead", state: "working" },
  { id: "rant-5", text: "Use the strongest model for those jobs", where: "Set for jobs 3 and 4", state: "done" },
  { id: "rant-6", text: "Nibbii onboarding copy sounds robotic, fix it", where: "Nibbii lead", state: "working" },
  { id: "rant-7", text: "That storage thing on the Mac again", where: "Chief of Staff", state: "unclear" },
];
const EARLIER: Asked[] = [
  { id: "old-1", text: "Ship the new build once everything is merged", where: "Hivra lead", state: "done" },
  { id: "old-2", text: "Rename the app, but last", where: "Hivra lead", state: "waiting" },
  { id: "old-3", text: "Move the EXO upload to the spare account", where: "EXO lead", state: "working" },
];
function receiptReply(): string {
  addAsked(RECEIPT);
  const word = { working: "working", done: "done", waiting: "waiting on purpose", unclear: "**unclear, I need to ask you**" };
  return [
    "Got it. I heard seven things. Five are with the right first mates, one is already done, and one I need you to clear up. I do none of the work myself, so keep talking.",
    "",
    ...RECEIPT.map((item, index) => `${index + 1}. **${item.text}.** ${item.where}, ${word[item.state]}.`),
    "",
    "Which storage thing did you mean in 7: clearing old build files again, or the backup disk filling up?",
    "",
    "All seven are in *You asked*, and each one is checked against your words before it's marked done.",
  ].join("\n");
}

const SEED_VERSION = "mockup-v6-one-chat";
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
  set("monocode:hub-chats", EXAMPLE.rooms(now));
  seedMockupIpc(now);
  set("monocode:mockup-asked", EARLIER);
  // The Inbox on Home reads every project the app has opened: the example projects' folders, so it has items to show.
  set("monocode.recentProjects", EXAMPLE.projects.flatMap((project) => (project.folder ? [{ path: project.folder, openedAt: now }] : [])));
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

Object.assign(window, { __MONOCODE_MOCKUP__: true, __mockupIpc: mockupIpc });

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
    // A long message with several asks in it gets a receipt: the asks it heard, numbered, each one tracked.
    if (typed.includes("the more I want the main chat back") || typed.length > 400) return receiptReply();
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

// The mock-up's own bar (not part of the app): which direction is on, the example long message, and a fresh start.
const DIRECTIONS: [Direction, string, string][] = [
  ["a", "A", "One chat: the three lists are chips at the top of the chat"],
  ["b", "B", "Board: every job beside the chat"],
  ["c", "C", "Mix: Needs you beside the chat"],
  ["d", "D", "Projects: today's app, a chat per project"],
];
function mockupBar(): void {
  const bar = document.createElement("div");
  bar.setAttribute("data-mockup-bar", "");
  bar.className = "solid-panel-glass fixed bottom-12 left-[76px] z-[9999] flex w-[184px] flex-wrap items-center gap-0.5 rounded-xl p-1 font-sans text-[12px] text-content";
  const button = (label: string, title: string, run: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.title = title;
    node.className = "h-7 rounded-lg px-2 text-content/70 hover:bg-content/8 hover:text-content";
    node.addEventListener("click", run);
    bar.appendChild(node);
    return node;
  };
  const label = document.createElement("span");
  label.textContent = "Mock-up";
  label.className = "px-1.5 text-content/60";
  bar.appendChild(label);
  const picks = DIRECTIONS.map(([id, name, title]) => {
    const node = button(name, title, () => {
      setDirection(id);
      paint();
    });
    node.dataset.mockupDirection = id;
    return node;
  });
  const paint = () => {
    const on = localStorage.getItem("monocode:mockup-direction") ?? "c";
    for (const node of picks) node.className = `h-7 rounded-lg px-2 ${node.dataset.mockupDirection === on ? "bg-content text-background-base" : "text-content/70 hover:bg-content/8 hover:text-content"}`;
  };
  paint();
  button("Paste example rant", "Puts an example long message with seven asks into the open chat's box", () => {
    const boxes = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea.composer-field")).filter((box) => box.offsetParent !== null);
    const box = boxes[boxes.length - 1];
    if (!box) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, RANT);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
  }).dataset.mockupRant = "";
  button("Start over", "Puts the example data back", () => {
    location.search = "?reset";
  });
  document.body.appendChild(bar);
}
if (document.body) mockupBar();
else addEventListener("DOMContentLoaded", mockupBar);
