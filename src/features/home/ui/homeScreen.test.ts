// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultArrangement, hideSection, pinPanel } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HomeScreen, type HomeChief, type HomeDone, type HomeNeed, type HomeWork } from "./HomeScreen";

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
      onMove: () => undefined,
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

it("with nothing to show, says nothing needs you and keeps the chat", () => {
  draw();
  expect(container.querySelector("[data-home-section]")).toBeNull();
  expect(container.querySelector("[data-home-empty]")?.textContent).toContain("Nothing needs you.");
  expect(container.querySelector("h1")?.textContent).toBe("Home");
  expect(container.querySelector("[data-home-date]")?.textContent).toBe("Wednesday 11 November");
  expect(container.querySelector("[data-home-start]")).not.toBeNull();
  expect(container.textContent).not.toContain("All quiet.");
  expect(container.textContent).not.toContain("Projects");
  expect(container.querySelector("[data-home-summary]")).toBeNull();
  expect(container.querySelector("[data-home-no-projects]")).toBeNull();
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Ask']")!;
  expect(input.placeholder).toBe("Ask anything, or hand work to any project");
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
  let moved = "";
  draw({
    needs: [{ key: "n1", sentence: "Example: Should we ship?", stopped: false, actions: [], onOpen: () => undefined }],
    needsTotal: 1,
    arrangement,
    onMove: (key, dir) => { moved = `${key}:${dir}`; },
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example</p>", permissions: [] } }],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).toBeNull();
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  expect(container.textContent).not.toContain("Pin a panel");
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  const panel = container.querySelector("[data-home-customize]")!;
  expect(panel.getAttribute("role")).toBe("dialog");
  const showNeeds = panel.querySelector<HTMLButtonElement>("[role='switch'][aria-label='Show Needs you']")!;
  expect(showNeeds.getAttribute("aria-checked")).toBe("false");
  expect(showNeeds.tabIndex).not.toBe(-1);
  const up = panel.querySelector<HTMLButtonElement>("[aria-label='Move Working now up']")!;
  expect(up.tabIndex).not.toBe(-1);
  act(() => up.click());
  expect(moved).toBe("moving-now:-1");
  expect(panel.querySelector("[aria-label='Unpin Pinned panel']")).not.toBeNull();
  expect(panel.querySelector("[aria-label='Pin Example board']")).not.toBeNull();
  expect(container.textContent).not.toContain("Move Working now up");
  act(() => panel.querySelector<HTMLButtonElement>("button")!);
  const done = [...panel.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done")!;
  act(() => done.click());
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>("[data-home-action='customize']")!.click());
  act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(container.querySelector("[data-home-customize]")).toBeNull();
  expect(container.querySelector("[data-home-section='panel:my-panels:missing']")?.textContent).toContain("This panel is not available.");
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
  expect(send.className).not.toContain("bg-accent");
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Ask']")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set!.call(input, "hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector("button[aria-label='Send']")?.className).toContain("bg-accent");
});
