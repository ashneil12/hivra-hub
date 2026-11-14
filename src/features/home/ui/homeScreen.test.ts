// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { noteOneTapRefusal, resetOneTapRefusal } from "../../needs/model/oneTapNotice";
import { defaultArrangement, hideSection, pinPanel } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HomeScreen, dropCard, orderCards, stepCard, type HomeChief, type HomeDone, type HomeNeed, type HomeWork } from "./HomeScreen";

const chief: HomeChief = {
  missing: false,
  name: "Coordinator",
  options: [],
  onAdd: () => undefined,
  onOpenChat: () => undefined,
  onOption: () => undefined,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  viStub();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  resetOneTapRefusal();
  act(() => root.unmount());
  container.remove();
});

function viStub() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function draw(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  act(() => {
    root.render(createElement(HomeScreen, {
      date: "Wednesday 11 November",
      chief,
      needs: [],
      needsTotal: 0,
      builders: [],
      working: [],
      workingTotal: 0,
      done: [],
      onSeeNeeds: () => undefined,
      onSeeDone: () => undefined,
      arrangement: defaultArrangement(),
      catalog: [],
      known: true,
      failed: false,
      onOpen: () => undefined,
      onHide: () => undefined,
      onShow: () => undefined,
      onPin: () => undefined,
      onUnpin: () => undefined,
      onAsk: () => undefined,
      renderPanel: () => createElement("p", null, "Example board"),
      ...props,
    }));
  });
}

it("says why a one tap was refused", () => {
  noteOneTapRefusal("That chat isn't waiting any more.");
  draw();
  expect(container.querySelector("[data-needs-refusal]")?.textContent).toBe("That chat isn't waiting any more.");
});

it("with nothing to show, the chief says all quiet inside the card", () => {
  draw();
  expect(container.querySelector("[data-home-section]")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.textContent).not.toContain("Nothing needs you.");
  const card = container.querySelector("[data-home-start]")!;
  const line = card.querySelector("[data-home-quiet]");
  expect(line?.textContent).toBe("All quiet. Ask me anything, or hand work to any project.");
  expect(card.contains(line)).toBe(true);
  expect(container.querySelector("h1")?.textContent).toBe("Home");
  expect(container.querySelector("[data-home-date]")?.textContent).toBe("Wednesday 11 November");
  expect(container.textContent).not.toContain("All quiet. All quiet.");
  expect(container.textContent).not.toContain("Projects");
  expect(container.querySelector("[data-home-summary]")).toBeNull();
  expect(container.querySelector("[data-home-no-projects]")).toBeNull();
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Ask']")!;
  expect(input.placeholder).toBe("Ask anything, or hand work to any project");
});

it("a stopped or failed row leads, then a ship block, then a question", () => {
  const needs: HomeNeed[] = [
    { key: "q", sentence: "Example: Which font?", stopped: false, actions: [], onOpen: () => undefined },
    {
      key: "ship",
      sentence: "Example: Should we ship the notes?",
      stopped: false,
      blocksShip: true,
      actions: [
        { label: "Yes", onClick: () => undefined },
        { label: "Not yet", onClick: () => undefined },
      ],
      onOpen: () => undefined,
    },
    { key: "failed", sentence: "Example: The lead failed.", stopped: true, actions: [], onOpen: () => undefined },
  ];
  draw({ needs, needsTotal: 3 });
  const rows = [...container.querySelectorAll("[data-home-line='need']")];
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain("Stopped.");
  expect(rows[0]?.textContent).toContain("Example: The lead failed.");
  expect(rows[1]?.textContent).toContain("Example: Should we ship the notes?");
  expect(rows[2]?.textContent).toContain("Example: Which font?");
});

it("the chief's answer buttons are the same size as a needs row button", () => {
  draw({
    chief: {
      ...chief,
      you: "Example: what's blocking Hivra?",
      reply: "Example: Hivra is waiting on the notes.",
      options: [
        { id: "yes", label: "Yes, do that" },
        { id: "now", label: "Not now" },
      ],
    },
    needs: [{
      key: "n1",
      sentence: "Example: Should we ship the notes?",
      stopped: false,
      actions: [
        { label: "Yes", onClick: () => undefined },
        { label: "Not yet", onClick: () => undefined },
      ],
      onOpen: () => undefined,
    }],
    needsTotal: 1,
  });
  const answer = container.querySelector("[data-home-option='yes']")!;
  const row = container.querySelector("[data-home-action='Yes']")!;
  const quietAnswer = container.querySelector("[data-home-option='now']")!;
  const quietRow = container.querySelector("[data-home-action='Not yet']")!;
  for (const token of ["h-7", "px-2.5", "text-[12px]", "leading-none"]) {
    expect(answer.className).toContain(token);
    expect(row.className).toContain(token);
    expect(quietAnswer.className).toContain(token);
    expect(quietRow.className).toContain(token);
  }
});

it("hides an empty section and shows one that has a line", () => {
  const needs: HomeNeed[] = [{ key: "n1", sentence: "Example: Should we ship?", stopped: false, actions: [], onOpen: () => undefined }];
  const working: HomeWork[] = [{ key: "w1", text: "Example: 1 worker: notes", since: "since 03:40" }];
  draw({ needs, needsTotal: 1, working, workingTotal: 1 });
  expect(container.querySelector("[data-home-section='needs-you']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='moving-now']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='recent']")).toBeNull();
  expect(container.querySelector("[data-home-section='projects']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.querySelector("[data-home-quiet]")).toBeNull();
  expect(container.querySelector("[data-home-section='moving-now'] h2")?.textContent).toBe("Working now");
  expect(container.querySelector("[data-home-section='needs-you'] h2")?.textContent).toBe("Needs you");
  const needsHead = container.querySelector("[data-home-section='needs-you'] header")!;
  const title = needsHead.querySelector("h2")!;
  const count = needsHead.querySelector("[data-home-count]")!;
  expect(title.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(needsHead.querySelector("[data-home-mark='needs-you']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='moving-now'] [data-home-mark='working']")).not.toBeNull();
  const see = needsHead.querySelector("[data-home-see='needs']")!;
  expect(see.className).toContain("text-accent");
});

it("shows at most the rows it was given, and the count is the whole list", () => {
  const needs: HomeNeed[] = [{ key: "n1", project: "Hivra", sentence: "Example: Should we ship?", stopped: false, actions: [], onOpen: () => undefined }];
  let seen = 0;
  draw({ needs, needsTotal: 6, onSeeNeeds: () => { seen += 1; } });
  expect(container.querySelectorAll("[data-home-line='need']")).toHaveLength(1);
  expect(container.querySelector("[data-home-count='6']")?.textContent).toBe("6");
  const tag = container.querySelector("[data-home-project]")!;
  expect(tag.textContent).toBe("Hivra");
  expect(tag.className).toContain("border");
  expect(container.textContent).not.toContain("Crew");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-see='needs']")!.click());
  expect(seen).toBe(1);
});

it("a builders line sits in Needs you and does not add to the count", () => {
  const opened: HomeLine[] = [];
  const builders: HomeLine = {
    id: "builders:builders-disk",
    kind: "builders",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    projectId: "",
    target: "builders-disk",
    at: 0,
  };
  draw({ builders: [builders], onOpen: (line) => opened.push(line) });
  const row = container.querySelector("[data-home-section='needs-you'] [data-home-line='builders']");
  expect(row?.tagName).toBe("DIV");
  expect(row?.textContent).toContain("Free up space");
  expect(container.querySelector("[data-home-count]")).toBeNull();
  expect(container.querySelector("[data-home-see='needs']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  act(() => row?.querySelector<HTMLButtonElement>("button[data-home-action='free-up-space']")!.click());
  expect(opened).toEqual([builders]);
});

it("shows a spend pause with Raise limit, and leaves the disk pause on Free up space", () => {
  const opened: HomeLine[] = [];
  const spend: HomeLine = {
    id: "builders:builders-spend",
    kind: "builders",
    text: "Spend limit reached for hivra: $50 of $50 this month. Raise it, or wait for the month to reset.",
    projectId: "",
    target: "builders-spend",
    at: 0,
  };
  const disk: HomeLine = {
    id: "builders:builders-disk",
    kind: "builders",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    projectId: "",
    target: "builders-disk",
    at: 0,
  };
  draw({ builders: [disk, spend], onOpen: (picked) => opened.push(picked) });
  const rows = container.querySelectorAll("[data-home-line='builders']");
  expect(rows).toHaveLength(2);
  const diskAction = rows[0]?.querySelector("button") as HTMLButtonElement;
  const spendAction = rows[1]?.querySelector("button") as HTMLButtonElement;
  expect(diskAction.dataset.homeAction).toBe("free-up-space");
  expect(diskAction.textContent).toBe("Free up space");
  expect(spendAction.dataset.homeAction).toBe("raise-limit");
  expect(spendAction.textContent).toBe("Raise limit");
  expect(rows[1]?.textContent).not.toMatch(/[—–]/);
  act(() => spendAction.click());
  expect(opened).toEqual([spend]);
});

it("does not say nothing needs you before the first load", () => {
  draw({ known: false, failed: false });
  expect(container.querySelector("[data-home-loading]")).not.toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.querySelector("[data-home-start]")).toBeNull();
  draw({ known: false, failed: true });
  expect(container.querySelector("[data-home-retry]")?.textContent).toContain("Couldn't load home. Trying again.");
  expect(container.querySelector("[data-home-empty]")).toBeNull();
});

it("keeps customize on one button: a panel of switches, not a wall of links", () => {
  const arrangement = pinPanel(hideSection(defaultArrangement(), "needs-you"), "my-panels", "missing");
  draw({
    needs: [{ key: "n1", sentence: "Example: Should we ship?", stopped: false, actions: [], onOpen: () => undefined }],
    needsTotal: 1,
    arrangement,
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example</p>", permissions: [] } }],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).toBeNull();
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  expect(container.textContent).not.toContain("Pin a panel");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  const panel = container.querySelector("[data-home-customize]")!;
  expect(panel.getAttribute("role")).toBe("dialog");
  const header = container.querySelector("[data-home-header]")!;
  const card = container.querySelector("[data-home-start]")!;
  expect(header.contains(panel)).toBe(false);
  expect(panel.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(panel.className).not.toMatch(/\b(?:absolute|fixed)\b/);
  expect(panel.className).not.toMatch(/\bshadow-(?:md|lg|xl|2xl)\b/);
  expect(panel.className).not.toMatch(/bg-background-base/);
  const showNeeds = panel.querySelector<HTMLButtonElement>("[role='switch'][aria-label='Show Needs you']")!;
  expect(showNeeds.getAttribute("aria-checked")).toBe("false");
  expect(showNeeds.tabIndex).not.toBe(-1);
  // A card is moved by dragging it on the page, and from the keyboard by its two arrows here.
  expect(panel.querySelector<HTMLButtonElement>("[aria-label='Move Needs you up']")?.tabIndex).not.toBe(-1);
  expect(panel.querySelector("[aria-label='Move Needs you down']")).not.toBeNull();
  expect(panel.querySelector("[data-home-action='add-card']")?.textContent).toContain("Ask for a new card");
  expect(panel.querySelector("[aria-label='Unpin Pinned panel']")).not.toBeNull();
  expect(panel.querySelector("[aria-label='Pin Example board']")).not.toBeNull();
  act(() => panel.querySelector<HTMLButtonElement>("button")!);
  const done = [...panel.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done")!;
  act(() => done.click());
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  expect(container.querySelector("[data-home-section='panel:my-panels:missing']")?.textContent).toContain("This panel is not available.");
});

it("a pinned page is a card with its title and its content", () => {
  const arrangement = pinPanel(defaultArrangement(), "my-panels", "board");
  draw({
    arrangement,
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example: board</p>", permissions: [] } }],
    renderPanel: () => createElement("p", null, "Example: board"),
  });
  const card = container.querySelector("[data-home-section='panel:my-panels:board']")!;
  expect(card.querySelector("h2")?.textContent).toBe("Example board");
  expect(card.querySelector("[data-home-panel]")?.textContent).toContain("Example: board");
});

it("customize rows share one set of columns, with an empty unpin slot on a section", () => {
  const arrangement = pinPanel(defaultArrangement(), "my-panels", "board");
  draw({
    arrangement,
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example: board</p>", permissions: [] } }],
  });
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  const rows = [...container.querySelectorAll("[data-home-arrange]")];
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) expect(row.children).toHaveLength(5);
  const section = container.querySelector("[data-home-arrange='moving-now'] [data-home-unpin]")!;
  expect(section.querySelector("button")).toBeNull();
  expect(container.querySelector("[data-home-arrange='panel:my-panels:board'] [data-home-unpin] button")?.textContent).toBe("Unpin");
});

it("an empty ask says nothing", () => {
  const asked: string[] = [];
  draw({ onAsk: (text) => asked.push(text) });
  const start = container.querySelector("[data-home-start]")!;
  const send = start.querySelector<HTMLButtonElement>("button[aria-label='Send']")!;
  expect(send.disabled).toBe(true);
  act(() => start.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(asked).toEqual([]);
});

it("with no chief, offers to add one and does not ask", () => {
  let added = 0;
  draw({ chief: { ...chief, missing: true, onAdd: () => { added += 1; } } });
  expect(container.querySelector("[data-home-no-chief]")?.textContent).toContain("There is no Chief of Staff.");
  expect(container.querySelector("input")).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='add-chief']")!.click());
  expect(added).toBe(1);
});

it("names the chief, the scope, and opens the same chat", () => {
  let opened = 0;
  draw({
    chief: { ...chief, scope: "read all 7 projects", you: "how is EXO going?", reply: "EXO is fine.", onOpenChat: () => { opened += 1; } },
  });
  const card = container.querySelector("[data-home-start]")!;
  expect(card.className).toContain("border");
  expect(card.querySelector("[data-home-avatar='chief']")?.textContent).toBe("CS");
  expect(card.querySelector("[data-home-chief]")?.textContent).toBe("Chief of Staff");
  expect(card.querySelector("[data-home-chief]")?.className).toMatch(/font-semibold|font-bold/);
  const scope = card.querySelector("[data-home-scope]")!;
  expect(scope.textContent).toBe("read all 7 projects");
  expect(scope.className).toContain("text-content/60");
  expect(card.querySelector("[data-home-chief]")?.parentElement).toBe(scope.parentElement);
  const form = card.querySelector("form")!;
  expect(card.querySelector("[data-home-you]")!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(card.querySelector("[data-home-reply]")!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(container.querySelector("[data-home-you] .user-message-bubble")?.textContent).toBe("how is EXO going?");
  expect(container.querySelector("[data-home-reply]")?.textContent).toContain("EXO is fine.");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='open-chat']")!.click());
  expect(opened).toBe(1);
});

it("labels each line with who said it, and sets Ash's line apart", () => {
  draw({
    chief: { ...chief, name: "Coordinator", you: "how is EXO going?", reply: "EXO is fine." },
  });
  expect(container.querySelector("[data-home-speaker='you']")?.textContent).toBe("You");
  expect(container.querySelector("[data-home-speaker='you']")?.className).toContain("sr-only");
  expect(container.querySelector("[data-home-speaker='chief']")?.textContent).toBe("Chief of Staff");
  expect(container.querySelector("[data-home-reply]")?.textContent).not.toMatch(/chief-of-staff/);
  expect(container.querySelector("[data-home-reply]")?.textContent).not.toContain("Coordinator");
  const you = container.querySelector("[data-home-you]")!;
  expect(you.className).toMatch(/items-end|justify-end/);
  expect(you.querySelector(".user-message-bubble")?.textContent).toBe("how is EXO going?");
});

it("a suggested reply is a button under the reply", () => {
  let picked = "";
  draw({
    chief: {
      ...chief,
      you: "how is EXO going?",
      reply: "EXO is fine.",
      options: [{ id: "ok", label: "Sounds good" }],
      onOption: (id) => { picked = id; },
    },
  });
  const option = container.querySelector<HTMLButtonElement>("[data-home-option='ok']")!;
  expect(option.tagName).toBe("BUTTON");
  expect(option.textContent?.trim()).toBe("Sounds good");
  expect((option.getAttribute("aria-label") ?? option.textContent) || "").toContain("Sounds good");
  expect(option.tabIndex).not.toBe(-1);
  expect(option.className).toContain("rounded-md");
  expect(option.className).toContain("bg-accent");
  const text = container.querySelector("[data-home-reply-text]")!;
  expect(text.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  act(() => option.click());
  expect(picked).toBe("ok");
});

it("shows a streaming reply as words, not a blank box", () => {
  draw({
    chief: { ...chief, you: "how is EXO going?", reply: "EXO ", streaming: true },
  });
  const reply = container.querySelector("[data-home-reply]")!;
  expect(reply.className).not.toContain("border");
  expect(reply.textContent).toContain("EXO");
  expect(reply.textContent).not.toContain("Replying");
  expect(reply.querySelector("[data-home-streaming]")).not.toBeNull();
});

it("does not leave an empty box before the first word", () => {
  draw({ chief: { ...chief, you: "how is EXO going?", streaming: true } });
  expect(container.querySelector("[data-home-reply]")?.className ?? "").not.toContain("border");
  expect(container.textContent).not.toContain("Replying");
  expect(container.querySelector("[data-home-streaming]")?.textContent).toContain("Thinking");
});

it("a stopped row says Stopped, then the reason, then Open chat", () => {
  const clicked: string[] = [];
  const needs: HomeNeed[] = [{
    key: "stopped:1",
    project: "Hivra",
    sentence: "Example: The notes worker stopped.",
    stopped: true,
    actions: [{ label: "Open Ada's chat", onClick: () => clicked.push("action") }],
    onOpen: () => clicked.push("open"),
  }];
  draw({ needs, needsTotal: 1 });
  const row = container.querySelector("[data-home-line='need']")!;
  expect(row.tagName).toBe("DIV");
  expect(row.textContent).not.toContain("Needs you");
  expect(row.textContent).not.toContain("Stuck");
  expect(container.textContent).not.toContain("Stuck");
  const stopped = row.querySelector<HTMLElement>("[data-home-stopped]")!;
  expect(stopped.textContent).toBe("Stopped.");
  expect(["rgb(255, 107, 107)", "#ff6b6b", "rgb(255,107,107)"]).toContain(stopped.style.color);
  expect(row.textContent?.indexOf("Stopped.")).toBeLessThan(row.textContent?.indexOf("Example: The notes worker stopped.") ?? -1);
  const button = row.querySelector<HTMLButtonElement>("[data-home-action='Open chat']")!;
  expect(button.className).toContain("border");
  expect(button.className).not.toContain("bg-accent");
  act(() => button.click());
  expect(clicked).toEqual(["action"]);
});

it("a row whose only way on is Open keeps a bordered button, not the blue one", () => {
  const needs: HomeNeed[] = [{
    key: "q0",
    project: "EXO",
    sentence: "Example: Ready to merge #12.",
    stopped: false,
    actions: [{ label: "Open", onClick: () => undefined }],
    onOpen: () => undefined,
  }];
  draw({ needs, needsTotal: 1 });
  const button = container.querySelector<HTMLButtonElement>("[data-home-line='need'] [data-home-action='Open']")!;
  expect(button.className).toContain("border");
  expect(button.className).not.toContain("bg-accent");
});

it("a question row shows its own actions, the first one blue", () => {
  const clicked: string[] = [];
  const needs: HomeNeed[] = [{
    key: "q1",
    project: "EXO",
    sentence: "Example: Should we ship the notes?",
    stopped: false,
    actions: [
      { label: "Yes", onClick: () => clicked.push("yes") },
      { label: "Not yet", onClick: () => clicked.push("not") },
      { label: "Later", onClick: () => clicked.push("later") },
      { label: "Never", onClick: () => clicked.push("never") },
    ],
    onOpen: () => clicked.push("open"),
  }];
  draw({ needs, needsTotal: 1 });
  const row = container.querySelector("[data-home-line='need']")!;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("[data-home-action]")];
  expect(buttons.map((button) => button.getAttribute("data-home-action"))).toEqual(["Yes", "Not yet", "Later"]);
  expect(buttons[0]?.className).toContain("bg-accent");
  expect(buttons[1]?.className).toContain("border");
  expect(buttons[1]?.className).not.toContain("bg-accent");
  act(() => buttons[0]?.click());
  act(() => buttons[1]?.click());
  expect(clicked).toEqual(["yes", "not"]);
});

it("shows working and done lines, with the worker count and the time", () => {
  const working: HomeWork[] = [{ key: "hivra", project: "Hivra", text: "Example: 4 workers: chat move fixes, PR watch, commit guard, crew locks", since: "since 03:40", onOpen: () => undefined }];
  const done: HomeDone[] = [{ key: "m1", project: "EXO", text: "Example: Merged the notes", time: "09:05", onOpen: () => undefined }];
  draw({ working, workingTotal: 4, done });
  const workingHead = container.querySelector("[data-home-section='moving-now'] header")!;
  expect(workingHead.querySelector("h2")?.compareDocumentPosition(workingHead.querySelector("[data-home-workers]")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(container.querySelector("[data-home-workers]")?.textContent).toBe("4 workers");
  expect(container.querySelector("[data-home-since]")?.textContent).toBe("since 03:40");
  const doneHead = container.querySelector("[data-home-section='recent'] header")!;
  expect(doneHead.querySelector("h2")?.textContent).toBe("Done today");
  expect(doneHead.querySelector("[data-home-mark='done']")).not.toBeNull();
  expect(doneHead.querySelector("[data-home-done]")?.textContent).toBe("1");
  expect(container.querySelector("[data-home-time]")?.textContent).toBe("09:05");
  expect(container.querySelector("[data-home-see='done']")).toBeNull();
  expect(container.textContent).not.toContain("Crew");
});

it("with no exchange, the card is the name line and the composer", () => {
  draw({ chief: { ...chief, name: "Coordinator", scope: "read all 7 projects" } });
  const card = container.querySelector("[data-home-start]")!;
  expect(card.querySelector("[data-home-you]")).toBeNull();
  expect(card.querySelector("[data-home-reply]")).toBeNull();
  expect(card.querySelector("[data-home-action='open-chat']")).toBeNull();
  expect(card.querySelector("[data-home-avatar='chief']")?.textContent).toBe("CS");
  expect(card.querySelector("[data-home-chief]")?.textContent).toBe("Chief of Staff");
  expect(card.querySelector("form")).not.toBeNull();
});

it("the send arrow turns blue once there is text", () => {
  draw();
  const send = container.querySelector<HTMLButtonElement>("button[aria-label='Send']")!;
  expect(send.querySelectorAll("path")).toHaveLength(2);
  expect(send.className).not.toContain("bg-accent");
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Ask']")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set!.call(input, "hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector("button[aria-label='Send']")?.className).toContain("bg-accent");
});

it("orders the cards the way they were dragged, and a drop takes the other card's place", () => {
  const cards = [{ key: "moving-now" }, { key: "recent" }, { key: "pages" }, { key: "automations" }];
  expect(orderCards(cards, []).map((card) => card.key)).toEqual(["moving-now", "recent", "pages", "automations"]);
  // A card that was never dragged (a new one) keeps its own place after the dragged ones.
  expect(orderCards(cards, ["pages", "moving-now"]).map((card) => card.key)).toEqual(["pages", "moving-now", "recent", "automations"]);
  const keys = cards.map((card) => card.key);
  expect(dropCard(keys, "automations", "moving-now")).toEqual(["automations", "moving-now", "recent", "pages"]);
  expect(dropCard(keys, "moving-now", "pages")).toEqual(["recent", "pages", "moving-now", "automations"]);
  expect(dropCard(keys, "recent", "recent")).toEqual(keys);
  expect(dropCard(keys, "missing", "recent")).toEqual(keys);
});

it("Move up and Move down step a card past the row beside it, whatever sits between them on the page", () => {
  const keys = ["needs-you", "pages", "moving-now", "recent"];
  const rows = ["needs-you", "moving-now", "recent"];
  expect(stepCard(keys, rows, "moving-now", -1)).toEqual(["moving-now", "needs-you", "pages", "recent"]);
  expect(stepCard(keys, rows, "needs-you", 1)).toEqual(["pages", "moving-now", "needs-you", "recent"]);
  expect(stepCard(keys, rows, "needs-you", -1)).toEqual(keys);
  expect(stepCard(keys, rows, "recent", 1)).toEqual(keys);
  expect(stepCard(keys, rows, "pages", -1)).toEqual(keys);
});

it("Move up in Customize moves the card on the page and its row in the panel, and saves the order", () => {
  const saved: string[][] = [];
  draw({
    needs: [{ key: "n1", sentence: "Example: Should we ship?", stopped: false, actions: [], onOpen: () => undefined }],
    needsTotal: 1,
    working: [{ key: "w1", text: "Example: building the page", since: "2 min" }],
    workingTotal: 1,
    onReorder: (keys) => saved.push(keys),
  });
  const order = () => container.querySelector("[data-home]")!.getAttribute("data-home-order");
  expect(order()).toBe("needs-you moving-now");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  const up = container.querySelector<HTMLButtonElement>("[aria-label='Move Working now up']")!;
  act(() => up.click());
  expect(order()).toBe("moving-now needs-you");
  const rowsNow = [...container.querySelectorAll("[data-home-arrange]")].map((row) => row.getAttribute("data-home-arrange"));
  expect(rowsNow.indexOf("moving-now")).toBeLessThan(rowsNow.indexOf("needs-you"));
  expect(container.querySelector<HTMLButtonElement>("[aria-label='Move Working now up']")!.disabled).toBe(true);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.slice(0, 2)).toEqual(["moving-now", "needs-you"]);
});

it("a card is picked up by its title row, and Ask for a new card puts the words in the Chief of Staff's box", () => {
  draw({ working: [{ key: "w1", project: "Example", text: "Example: 1 worker", since: "" }], workingTotal: 1 });
  const grip = container.querySelector<HTMLElement>("[data-home-section='moving-now'] [data-home-grip]")!;
  expect(grip.getAttribute("draggable")).toBe("true");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='add-card']")!.click());
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  expect(container.querySelector<HTMLInputElement>("input[aria-label='Ask']")!.value).toBe("Add a card to Home that shows ");
});

it("shows loading and failed-load states instead of a blank Home body", () => {
  draw({ known: false });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading Home…");
  draw({ known: false, failed: true });
  expect(container.querySelector('[data-home-retry]')?.textContent).toContain("Trying again");
});
