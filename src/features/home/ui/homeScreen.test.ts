// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultArrangement, hideSection, pinPanel } from "../model/arrangement";
import type { HomeLine } from "../model/lines";
import { HomeScreen } from "./HomeScreen";

const line = (over: Partial<HomeLine>): HomeLine => ({
  id: "n1",
  kind: "decision",
  text: "Crew · Should we ship?",
  projectId: "crew",
  target: "ship",
  at: 1,
  ...over,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  const onOpen = props.onOpen ?? (() => undefined);
  act(() => {
    root.render(createElement(HomeScreen, {
      needsYou: [],
      moving: [],
      recent: [],
      arrangement: defaultArrangement(),
      catalog: [],
      known: true,
      failed: false,
      onOpen,
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

it("hides an empty section, says all quiet, and keeps the chat at the top", () => {
  draw();
  expect(container.querySelector("[data-home-section]")).toBeNull();
  expect(container.querySelector("[data-home-empty]")?.textContent).toContain("All quiet.");
  expect(container.querySelector("[data-home] > div")?.firstElementChild?.hasAttribute("data-home-start")).toBe(true);
  expect(container.textContent).not.toContain("Start a chat with Crew");
  expect(container.querySelector("[data-home-summary]")).toBeNull();
  expect(container.querySelector("[data-count]")).toBeNull();
  expect(container.textContent).not.toMatch(/\d/);
});

it("shows a section that has a line and hides one that does not", () => {
  draw({
    needsYou: [line({})],
    moving: [line({ id: "m1", kind: "moving", text: "Crew · Write the notes · Ada" })],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='moving-now']")).not.toBeNull();
  expect(container.querySelector("[data-home-section='recent']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.querySelector("[data-home] > div")?.firstElementChild?.hasAttribute("data-home-start")).toBe(true);
});

it("shows the morning summary only when it has a line", () => {
  draw({
    summary: [{ id: "task-1", kind: "task", text: "Crew · Write the notes", projectId: "crew" }],
  });
  expect(container.querySelector("[data-home-summary]")?.textContent).toContain("Crew · Write the notes");
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  draw({ summary: [] });
  expect(container.querySelector("[data-home-summary]")).toBeNull();
  expect(container.querySelector("[data-home-empty]")?.textContent).toContain("All quiet.");
});

it("does not say all quiet before the first load, including when the load failed", () => {
  draw({ known: false, failed: false });
  expect(container.querySelector("[data-home-loading]")).not.toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  draw({ known: false, failed: true });
  expect(container.querySelector("[data-home-retry]")?.textContent).toContain("Couldn't load home. Trying again.");
  expect(container.querySelector("[data-home-empty]")).toBeNull();
});

it("keeps a hidden section hidden and still lists a pinned panel that is not in the catalog", () => {
  const arrangement = pinPanel(hideSection(defaultArrangement(), "needs-you"), "my-panels", "missing");
  draw({
    needsYou: [line({})],
    arrangement,
    catalog: [{ plugin: "my-panels", panelId: "board", title: "Example board", spec: { kind: "bespoke", title: "Example board", html: "<p>Example</p>", permissions: [] } }],
  });
  expect(container.querySelector("[data-home-section='needs-you']")).toBeNull();
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  expect(container.textContent).toContain("Show Needs you");
  expect(container.querySelector("[data-home-section='panel:my-panels:missing']")?.textContent).toContain("This panel is not available.");
  expect(container.textContent).toContain("Pin Example board");
});

it("shows a builders line in Needs you with its own Free up space action, and the action opens it", () => {
  const opened: HomeLine[] = [];
  const builders = line({
    id: "builders:builders-disk",
    kind: "builders",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    projectId: "",
    target: "builders-disk",
    at: 0,
  });
  draw({ needsYou: [builders, line({})], onOpen: (picked) => opened.push(picked) });
  const row = container.querySelector("[data-home-section='needs-you'] [data-home-line='builders']");
  expect(row?.textContent).toContain("New builders are waiting: 24 GB free, under the 30 GB floor");
  expect(row?.textContent).toContain("Free up space");
  // The row holds a text and one button; it is not itself a button (no button inside a button).
  expect(row?.tagName).toBe("DIV");
  const action = row?.querySelector("button[data-home-action='free-up-space']") as HTMLButtonElement | null;
  expect(action?.textContent).toBe("Free up space");
  expect(row?.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  // The other line in the section is still a plain button that opens its own place.
  expect(container.querySelector("button[data-home-line='decision']")?.textContent).toContain("Crew · Should we ship?");
  act(() => action?.click());
  expect(opened).toEqual([builders]);
});

it("shows a spend pause with Raise limit, and leaves the disk pause on Free up space", () => {
  const opened: HomeLine[] = [];
  const spend = line({
    id: "builders:builders-spend",
    kind: "builders",
    text: "Spend limit reached for hivra: $50 of $50 this month. Raise it, or wait for the month to reset.",
    projectId: "",
    target: "builders-spend",
    at: 0,
  });
  const disk = line({
    id: "builders:builders-disk",
    kind: "builders",
    text: "New builders are waiting: 24 GB free, under the 30 GB floor",
    projectId: "",
    target: "builders-disk",
    at: 0,
  });
  draw({ needsYou: [disk, spend], onOpen: (picked) => opened.push(picked) });
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

it("asks with one box and one send button, and an empty ask says nothing", () => {
  const asked: string[] = [];
  draw({ onAsk: (text) => asked.push(text) });
  const start = container.querySelector("[data-home-start]")!;
  // One visible "Ask" at most: the label is the box's accessible name and its placeholder, not a heading over it.
  expect(start.textContent).not.toContain("Ask");
  const input = start.querySelector<HTMLInputElement>("input[aria-label='Ask']")!;
  expect(input.placeholder).toMatch(/Ask what's happening/);
  const send = start.querySelector<HTMLButtonElement>("button[aria-label='Send']")!;
  expect(send.disabled).toBe(true);
  act(() => start.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(asked).toEqual([]);
});

it("lists every project in the overview, and opens one", () => {
  const opened: HomeLine[] = [];
  draw({
    projects: [
      line({ id: "project:crew", kind: "project", text: "Crew · needs you", target: "crew" }),
      line({ id: "project:notes", kind: "project", text: "Notes", projectId: "notes", target: "notes" }),
    ],
    onOpen: (item) => opened.push(item),
  });
  const section = container.querySelector("[data-home-section='projects']")!;
  expect(section.querySelector("h2")?.textContent).toBe("Projects");
  const rows = [...section.querySelectorAll<HTMLButtonElement>("[data-home-line='project']")];
  expect(rows.map((row) => row.textContent)).toEqual(["Crew · needs you", "Notes"]);
  act(() => rows[1].click());
  expect(opened.map((item) => item.target)).toEqual(["notes"]);
  // A list of projects with nothing happening in them is still a quiet Home.
  expect(container.querySelector("[data-home-empty]")?.textContent).toContain("All quiet.");
});

it("says why there are no projects instead of all quiet, and offers the way back", () => {
  let brought = 0;
  let made = 0;
  draw({ noProjects: { inAshOs: true }, onBringOver: () => brought++, onNewProject: () => made++ });
  const note = container.querySelector("[data-home-no-projects]")!;
  expect(note.textContent).toContain("Your projects haven't come over from Ash OS yet.");
  expect(container.querySelector("[data-home-empty]")).toBeNull();
  act(() => note.querySelector<HTMLButtonElement>("[data-home-action='bring-over']")!.click());
  act(() => note.querySelector<HTMLButtonElement>("[data-home-action='new-project']")!.click());
  expect([brought, made]).toEqual([1, 1]);

  draw({ noProjects: { inAshOs: true, busy: true, outcome: "Ash OS didn't answer. Try again when it's running." }, onBringOver: () => brought++ });
  expect(container.querySelector<HTMLButtonElement>("[data-home-action='bring-over']")?.disabled).toBe(true);
  expect(container.querySelector("[data-home-import-outcome]")?.textContent).toContain("Ash OS didn't answer.");

  draw({ noProjects: { inAshOs: false }, onBringOver: () => brought++, onNewProject: () => made++ });
  expect(container.querySelector("[data-home-no-projects]")?.textContent).toContain("No projects yet.");
  expect(container.querySelector("[data-home-action='bring-over']")).toBeNull();
});

it("puts the Needs you count immediately after the title", () => {
  draw({
    needsYou: [line({})],
    needsMark: 5,
    moving: [line({ id: "m1", kind: "moving", text: "Crew · Write the notes" })],
  });
  const header = container.querySelector("[data-home-section='needs-you'] header")!;
  const title = header.querySelector("h2")!;
  const count = header.querySelector("[data-home-needs-count]")!;
  expect(title.textContent).toBe("Needs you");
  expect(count.textContent).toBe("5");
  expect(title.nextElementSibling).toBe(count);
  expect(title.className).not.toMatch(/\bflex-1\b/);
  const dot = header.querySelector("[data-home-needs-dot]");
  expect(dot).not.toBeNull();
  expect(title.previousElementSibling).toBe(dot);
  expect(count.className).not.toMatch(/text-red/);
  expect(count.className).toMatch(/text-content\//);
  expect(header.querySelector("[data-home-arrange]")?.className).toMatch(/\bml-auto\b/);
  // Other sections keep their title filling the row. This change is only the Needs you header.
  const movingTitle = container.querySelector("[data-home-section='moving-now'] h2");
  expect(movingTitle?.className).toMatch(/\bflex-1\b/);
});

it("shows a stopped worker as a chip, a red Stopped, the reason and a bordered Open chat", () => {
  let opened = 0;
  draw({
    needsYou: [line({
      id: "stopped:upload",
      kind: "stopped",
      text: "Example: Out of credits",
      projectId: "vg-game",
      projectName: "EXO",
      actions: [{ label: "Open chat", run: () => opened++ }],
    })],
  });
  const row = container.querySelector("[data-home-line='stopped']")!;
  expect(row.querySelector("[data-needs-chip]")?.textContent).toBe("EXO");
  const word = row.querySelector("[data-needs-stopped]")!;
  expect(word.textContent).toBe("Stopped.");
  expect(word.className).toMatch(/text-red-400/);
  expect(row.textContent).toContain("Example: Out of credits");
  expect(row.textContent).not.toMatch(/\bStuck\b/);
  const button = [...row.querySelectorAll("button")].find((item) => item.textContent === "Open chat")!;
  expect(button.className).toMatch(/\bborder\b/);
  expect(button.className).not.toMatch(/underline/);
  expect(button.className).not.toMatch(/primary-action/);
  expect(button.className).not.toMatch(/\bbg-accent\b/);
  act(() => button.click());
  expect(opened).toBe(1);
});

it("draws row actions as buttons, the first filled and the rest bordered, at most three", () => {
  const ran: string[] = [];
  draw({
    needsYou: [line({
      projectName: "Nibbii",
      actions: [
        { label: "Allow", run: () => ran.push("Allow") },
        { label: "Deny", run: () => ran.push("Deny") },
        { label: "Later", run: () => ran.push("Later") },
        { label: "Skip", run: () => ran.push("Skip") },
      ],
    })],
  });
  const row = container.querySelector("[data-home-line='decision']")!;
  expect(row.querySelector("[data-needs-chip]")?.textContent).toBe("Nibbii");
  const buttons = [...row.querySelectorAll("button")].filter((item) =>
    ["Allow", "Deny", "Later", "Skip"].includes(item.textContent ?? ""),
  );
  expect(buttons.map((item) => item.textContent)).toEqual(["Allow", "Deny", "Later"]);
  // The same blue primary Home uses for a chief reply. Not the white primary-action fill.
  expect(buttons[0]?.className).toMatch(/\bbg-accent\b/);
  expect(buttons[0]?.className).toMatch(/\btext-black\b/);
  expect(buttons[0]?.className).not.toMatch(/primary-action/);
  expect(buttons[0]?.className).not.toMatch(/underline/);
  expect(buttons[1]?.className).toMatch(/\bborder\b/);
  expect(buttons[1]?.className).not.toMatch(/primary-action/);
  expect(buttons[1]?.className).not.toMatch(/\bbg-accent\b/);
  expect(buttons[2]?.className).toMatch(/\bborder\b/);
  act(() => buttons[1]?.click());
  expect(ran).toEqual(["Deny"]);
});

it("keeps a blue button on a safe approval and borders both buttons on a risky one", () => {
  draw({
    needsYou: [
      line({
        id: "safe",
        text: "frank wants to run npm test.",
        actions: [
          { label: "Allow", run: () => undefined },
          { label: "Deny", run: () => undefined },
        ],
      }),
      line({
        id: "risk",
        text: "frank wants to run npm publish.",
        actions: [
          { label: "Allow once", run: () => undefined },
          { label: "Deny", run: () => undefined },
        ],
      }),
    ],
  });
  const rows = [...container.querySelectorAll("[data-home-line]")];
  const allow = [...rows[0]!.querySelectorAll("button")].find((item) => item.textContent === "Allow")!;
  expect(allow.className).toMatch(/\bbg-accent\b/);
  expect(allow.className).toMatch(/\btext-black\b/);
  const once = [...rows[1]!.querySelectorAll("button")].find((item) => item.textContent === "Allow once")!;
  const deny = [...rows[1]!.querySelectorAll("button")].find((item) => item.textContent === "Deny")!;
  expect(once.className).not.toMatch(/\bbg-accent\b/);
  expect(once.className).toMatch(/\bborder\b/);
  expect(deny.className).not.toMatch(/\bbg-accent\b/);
  expect(deny.className).toMatch(/\bborder\b/);
});

it("gives a page access ask one bordered Review", () => {
  let opened = 0;
  draw({
    needsYou: [line({
      text: "The Weekly views page asks to read YouTube stats.",
      actions: [{ label: "Review", run: () => { opened += 1; } }],
    })],
  });
  const row = container.querySelector("[data-home-line]")!;
  const buttons = [...row.querySelectorAll("button")].filter((item) =>
    item.textContent === "Review" || item.textContent === "Allow" || item.textContent === "Deny",
  );
  expect(buttons.map((item) => item.textContent)).toEqual(["Review"]);
  expect(buttons[0]?.className).toMatch(/\bborder\b/);
  expect(buttons[0]?.className).not.toMatch(/\bbg-accent\b/);
  act(() => buttons[0]?.click());
  expect(opened).toBe(1);
});

it("names a decision sentence by its project while the words stay the sentence", () => {
  let opened: HomeLine | undefined;
  draw({
    needsYou: [line({
      text: "Should we ship?",
      projectName: "Crew",
      target: "ship",
      actions: [{ label: "Answer", run: () => undefined }],
    })],
    onOpen: (item) => { opened = item; },
  });
  const row = container.querySelector("[data-home-line='decision']")!;
  const sentence = [...row.querySelectorAll("button")].find((item) => !item.hasAttribute("data-needs-answer"))!;
  expect(sentence.textContent).toBe("Should we ship?");
  expect(sentence.getAttribute("aria-label")).toBe("Crew · Should we ship?");
  act(() => sentence.click());
  expect(opened?.kind).toBe("decision");
  expect(opened?.target).toBe("ship");
});
