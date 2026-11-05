// @vitest-environment happy-dom
// H7: the first-launch card checks the four things a chat needs for real, fills each row as it lands, and only lets
// the person continue once all four have passed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupCheck, SetupFactId } from "../model/setupProof";
import { checkHubSetup } from "../model/setupProof";
import { pickFolders } from "../../../platform/tauri/fs";
import { HubOnboardingSetup } from "./HubOnboardingSetup";

vi.mock("../model/hubData", () => ({ hubData: () => ({ listProjects: () => [] }) }));
vi.mock("../../../platform/tauri/fs", () => ({ pickFolders: vi.fn(async () => ["/picked"]) }));
vi.mock("../model/setupProof", async (original) => ({
  ...(await original<object>()),
  checkHubSetup: vi.fn(),
}));

const mocked = vi.mocked(checkHubSetup);

const ids: SetupFactId[] = ["installed", "signedIn", "folder", "roundTrip"];
const rows = (missing: SetupFactId[] = [], detail = "All good."): SetupCheck[] =>
  ids.map((id) => ({ id, state: missing.includes(id) ? "missing" : "proved", detail }));
const answerWith = (checks: SetupCheck[]) =>
  mocked.mockImplementation(async (input) => {
    input?.onCheck?.(checks);
    return { checks, proved: checks.every((check) => check.state === "proved") };
  });

let root: Root;
let container: HTMLElement;
let proved: boolean[];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  proved = [];
  mocked.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.clearAllMocks();
});

/** The card starts its checks a tick after mount, so StrictMode's double mount does not run them twice. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const render = async () => {
  act(() => root.render(createElement(HubOnboardingSetup, { onProvedChange: (value: boolean) => proved.push(value) })));
  await settle();
};

describe("the setup card", () => {
  it("checks all four things by itself and says so when they pass", async () => {
    answerWith(rows());
    await render();
    for (const id of ids) {
      const row = container.querySelector(`[data-hub-setup-row="${id}"]`)!;
      expect(row.getAttribute("data-state")).toBe("proved");
    }
    expect(container.querySelector("[data-hub-setup]")!.getAttribute("data-proved")).toBe("yes");
    expect(container.querySelector("[data-hub-setup-done]")!.textContent).toBe("All four checks passed.");
    expect(proved[proved.length - 1]).toBe(true);
  });

  it("names Hivra, not the bundle, in the words a person reads", async () => {
    answerWith(rows(["installed"], ""));
    await render();
    expect(container.textContent).toContain("Hivra checks the four things a chat needs");
    expect(container.textContent).toContain("Hivra runs on Claude Code, which lives on your Mac like any other app.");
    expect(container.textContent).not.toContain("MonoCode");
  });

  it("shows what is missing in plain words and does not claim the setup works", async () => {
    answerWith(rows(["roundTrip"], "No answer: Claude Code did not answer."));
    await render();
    const row = container.querySelector('[data-hub-setup-row="roundTrip"]')!;
    expect(row.getAttribute("data-state")).toBe("missing");
    expect(row.textContent).toContain("No answer: Claude Code did not answer.");
    expect(container.querySelector("[data-hub-setup]")!.getAttribute("data-proved")).toBe("no");
    expect(container.querySelector("[data-hub-setup-done]")).toBeNull();
    expect(proved[proved.length - 1]).toBe(false);
  });

  it("checks again when asked, even for what passed before", async () => {
    answerWith(rows());
    await render();
    const again = container.querySelector("[data-hub-setup-again]") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    answerWith(rows(["installed"], "Claude Code not found."));
    act(() => again.click());
    await settle();
    expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
    expect(container.querySelector('[data-hub-setup-row="installed"]')!.getAttribute("data-state")).toBe("missing");
  });

  it("hands the chosen folder to the check", async () => {
    answerWith(rows(["folder"], "No folder to work in yet. Choose the folder your work lives in."));
    await render();
    answerWith(rows());
    act(() => (container.querySelector("[data-hub-setup-folder]") as HTMLButtonElement).click());
    await settle();
    expect(pickFolders).toHaveBeenCalled();
    expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ folder: "/picked" }));
    expect(container.querySelector('[data-hub-setup-row="folder"]')!.getAttribute("data-state")).toBe("proved");
  });
});
