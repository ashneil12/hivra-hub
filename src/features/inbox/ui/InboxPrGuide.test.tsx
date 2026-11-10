// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { GithubPrDiff } from "../model/githubTasks";
import { reviewGuideKey } from "../model/reviewGuide";
import { InboxPrGuide, type ReviewGuideWriter } from "./InboxPrGuide";

const diff: GithubPrDiff = {
  additions: 3,
  deletions: 1,
  files: [
    { path: "src/app.ts", additions: 2, deletions: 1 },
    { path: "yarn.lock", additions: 1, deletions: 0 },
  ],
  patch: "",
  truncated: false,
  headSha: "aaa111",
};

const answer = JSON.stringify({
  summary: "Adds a start-up check.",
  stops: [{ title: "The check", note: "Decides when to stop.", path: "src/app.ts", startLine: 12, endLine: 20, lookClosely: true }],
  mechanical: ["yarn.lock"],
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}: ${container.textContent}`);
  return found;
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => Promise.resolve());
}

function setup(writer: ReviewGuideWriter, disk = memoryDisk()) {
  const onOpen = vi.fn();
  const render = async (next: GithubPrDiff = diff) => {
    await act(async () =>
      root.render(
        <InboxPrGuide repo="acme/web" number={7} title="Check" cwd="/tmp/web" diff={next} onOpen={onOpen} disk={disk} writer={writer} />,
      ),
    );
    await flush();
  };
  return { disk, onOpen, render };
}

it("writes nothing until asked, then shows the stops and jumps to one", async () => {
  const run = vi.fn(async () => answer);
  const { onOpen, render, disk } = setup({ available: () => true, run });
  await render();
  expect(run).not.toHaveBeenCalled();
  expect(container.textContent).toContain("never posted to GitHub");
  expect(container.textContent).toContain("goes to the model that writes commit text");
  expect((await disk.readDoc(reviewGuideKey("acme/web", 7))).rev).toBe(0);

  await act(async () => button("Write guide").click());
  await flush();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toEqual([expect.stringContaining("src/app.ts (+2 -1)"), "/tmp/web"]);
  expect(container.textContent).toContain("Adds a start-up check.");
  expect(container.textContent).toContain("Look closely");
  expect(container.textContent).toContain("src/app.ts, lines 12 to 20");
  expect(container.querySelector("[aria-label='Mechanical files']")?.textContent).toContain("yarn.lock");
  expect(button("Rewrite guide")).toBeTruthy();

  const stop = [...container.querySelectorAll("ol[aria-label='Guide stops'] button")][0] as HTMLButtonElement;
  await act(async () => stop.click());
  expect(onOpen).toHaveBeenCalledWith("src/app.ts", 12);
});

it("says a guide kept for another head is for another version and hides its stops", async () => {
  const { render } = setup({ available: () => true, run: async () => answer });
  await render();
  await act(async () => button("Write guide").click());
  await flush();
  await render({ ...diff, headSha: "bbb222" });
  expect(container.textContent).toContain("This guide was written for another version of this pull request.");
  expect(container.textContent).not.toContain("out of date");
  expect(container.querySelector("ol[aria-label='Guide stops']")).toBeNull();
  await act(async () => button("Show that guide").click());
  expect(container.querySelector("ol[aria-label=\"Other version's guide stops\"]")).not.toBeNull();
  expect(button("Rewrite guide")).toBeTruthy();
});

it("shows a kept guide with a note when the diff on screen doesn't say its head", async () => {
  const { render } = setup({ available: () => true, run: async () => answer });
  await render();
  await act(async () => button("Write guide").click());
  await flush();
  await render({ ...diff, headSha: null });
  expect(container.textContent).toContain("Refresh the pull request to check this guide matches its latest commits.");
  expect(container.textContent).not.toContain("another version");
  expect(container.querySelector("ol[aria-label='Guide stops']")).not.toBeNull();
});

it("keeps the previous guide when the model fails", async () => {
  let fail = false;
  const { render } = setup({
    available: () => true,
    run: async () => {
      if (fail) throw new Error("Request timed out");
      return answer;
    },
  });
  await render();
  await act(async () => button("Write guide").click());
  await flush();
  fail = true;
  await act(async () => button("Rewrite guide").click());
  await flush();
  expect(container.querySelector("[role='alert']")?.textContent).toBe(
    "The model took too long. The guide was not changed.",
  );
  expect(container.textContent).toContain("Adds a start-up check.");
});

it("can't write without a model, and says why", async () => {
  const { render } = setup({ available: () => false, run: async () => answer });
  await render();
  expect(button("Write guide").disabled).toBe(true);
  expect(container.textContent).toContain("No model is connected to write a guide.");
});

it("shows a guide another window kept", async () => {
  const disk = memoryDisk();
  const { render } = setup({ available: () => true, run: async () => answer }, disk);
  await render();
  await act(async () => {
    await disk.write(reviewGuideKey("acme/web", 7), {
      repo: "acme/web",
      number: 7,
      headSha: "aaa111",
      writtenAt: 1,
      guide: { summary: "From the other window.", stops: [{ title: "Here", note: "", path: "src/app.ts", startLine: null, endLine: null, lookClosely: false }], mechanical: [], unplaced: [] },
    });
  });
  await flush();
  expect(container.textContent).toContain("From the other window.");
});
