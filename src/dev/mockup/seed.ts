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

const SEED_VERSION = "mockup-v7-one-chat";
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
  if (Date.now() - startedAt > 15_000 || steady >= 8) {
    startGuide();
    return;
  }
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


// The mock-up's own guide (not part of the app): it walks through one main chat a step at a time and does each step
// itself, so nobody has to work out where to click. The last step offers the other three layouts.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tap = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
function openChief(): void {
  if (document.querySelector("textarea.composer-field") && document.querySelector("[data-chief-tabs], [data-chief-chips]")) return;
  Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hub-home] button, nav button, aside button"))
    .find((button) => button.textContent?.trim() === "Chief of Staff")
    ?.click();
}
async function sendRant(): Promise<void> {
  if (localStorage.getItem("monocode:mockup-rant-sent")) return;
  const boxes = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea.composer-field")).filter((box) => box.offsetParent !== null);
  const box = boxes[boxes.length - 1];
  if (!box) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, RANT);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  await wait(400);
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  localStorage.setItem("monocode:mockup-rant-sent", "1");
}
type Step = { title: string; text: string; run: () => void | Promise<void> };
const STEPS: Step[] = [
  {
    title: "Your one main chat",
    text: "This is the Chief of Staff's chat. The idea: you stay here and run every project from it.",
    run: async () => {
      setDirection("c");
      openChief();
    },
  },
  {
    title: "You say everything at once",
    text: "I just sent a long example message for you, with seven different asks buried in it. Read the reply in the chat.",
    run: async () => {
      openChief();
      await wait(600);
      await sendRant();
    },
  },
  {
    title: "It says back what it heard",
    text: "The reply numbers all seven asks and who has each. The same list now sits on the right under You asked, so a long chat can't lose one.",
    run: () => tap("[data-chief-tab=asked]"),
  },
  {
    title: "Questions come to you here",
    text: "Needs you, on the right, collects questions from every project. I opened the first one. Answer it there without leaving this chat.",
    run: async () => {
      tap("[data-chief-tab=needs]");
      await wait(400);
      tap("[data-chief-needs] [data-inbox-need] button");
    },
  },
  {
    title: "See every job, step in if you want",
    text: "Working lists every job in every project. Hover one and press Open, then Take over. Hand back when you're done.",
    run: () => tap("[data-chief-tab=working]"),
  },
  {
    title: "Compare the other layouts",
    text: "That was layout C. Try the same chat in the others, then tell Claude which felt right.",
    run: () => undefined,
  },
];
const LAYOUTS: [Direction, string][] = [
  ["c", "C: lists beside the chat"],
  ["b", "B: jobs beside the chat"],
  ["a", "A: lists as buttons on top"],
  ["d", "D: today's app, no lists"],
];
function startGuide(): void {
  if (document.querySelector("[data-mockup-guide]")) return;
  let at = Number(sessionStorage.getItem("monocode:mockup-step") ?? "0") || 0;
  const card = document.createElement("div");
  card.setAttribute("data-mockup-guide", "");
  card.className = "solid-panel-glass fixed bottom-12 left-[76px] z-[9999] flex w-[184px] flex-col gap-2 rounded-xl p-3 font-sans text-[12px] leading-[17px] text-content";
  const quiet = "h-7 rounded-lg border border-content/20 px-2.5 text-[12px] text-content hover:bg-content/8 disabled:opacity-40";
  const filled = "h-7 rounded-lg bg-content px-2.5 text-[12px] font-medium text-background-base";
  const paint = () => {
    const step = STEPS[at];
    card.textContent = "";
    const count = document.createElement("div");
    count.className = "text-[11px] text-content/60";
    count.textContent = `Guide, step ${at + 1} of ${STEPS.length}`;
    const title = document.createElement("div");
    title.className = "text-[13px] font-medium text-content";
    title.textContent = step.title;
    const text = document.createElement("div");
    text.className = "text-content/80";
    text.textContent = step.text;
    card.append(count, title, text);
    if (at === STEPS.length - 1) {
      const on = localStorage.getItem("monocode:mockup-direction") ?? "c";
      for (const [id, label] of LAYOUTS) {
        const pick = document.createElement("button");
        pick.type = "button";
        pick.dataset.mockupDirection = id;
        pick.textContent = label;
        pick.className = `h-7 rounded-lg px-2 text-left text-[12px] ${id === on ? "bg-content text-background-base" : "text-content/80 hover:bg-content/8"}`;
        pick.addEventListener("click", () => {
          setDirection(id);
          openChief();
          paint();
        });
        card.append(pick);
      }
    }
    const row = document.createElement("div");
    row.className = "flex items-center gap-1.5 pt-1";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back";
    back.className = quiet;
    back.disabled = at === 0;
    back.addEventListener("click", () => go(at - 1));
    const next = document.createElement("button");
    next.type = "button";
    next.dataset.mockupNext = "";
    next.textContent = at === STEPS.length - 1 ? "Start over" : "Next";
    next.className = filled;
    next.addEventListener("click", () => {
      if (at === STEPS.length - 1) {
        sessionStorage.removeItem("monocode:mockup-step");
        location.search = "?reset";
      } else go(at + 1);
    });
    row.append(back, next);
    card.append(row);
  };
  const go = (to: number) => {
    at = Math.max(0, Math.min(STEPS.length - 1, to));
    sessionStorage.setItem("monocode:mockup-step", String(at));
    if (at < STEPS.length - 1) setDirection("c");
    paint();
    void STEPS[at].run();
  };
  document.body.appendChild(card);
  go(at);
}
