// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { VerifyOffer } from "./VerifyOffer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const FOLDER = "/code/plüg app";
const SOURCE = { kind: "npm", package: "e2e", version: "0.22.0" };

function payload(patch: Record<string, unknown> = {}) {
  return { surfaces: ["web"], installed: false, declined: false, revision: 3, source: SOURCE, ...patch };
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(folder = FOLDER) {
  await act(async () => {
    root.render(createElement(VerifyOffer, { projectFolder: folder }));
  });
}

describe("VerifyOffer", () => {
  it("does not install just by being shown, and a click waits for a yes", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_verify_offer") return payload();
      if (command === "plugins_install") return { status: "waiting", request: { steps: [] } };
      return undefined;
    });
    await show();
    expect(container.querySelector("[data-verify-sentence]")?.textContent).toBe("This project looks like a web app.");
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual(["plugins_verify_offer"]);
    await act(async () => {
      container.querySelector("button")!.click();
    });
    const install = vi.mocked(invoke).mock.calls.find((call) => call[0] === "plugins_install");
    expect(install?.[1]).toEqual({ source: SOURCE, requestedBy: { kind: "person" }, project: FOLDER });
    expect(container.querySelector("[data-verify-status]")?.textContent).toBe("Waiting for your OK in the Inbox");
    expect(container.querySelector("[data-verify-offer]")).not.toBeNull();
    const installButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Install");
    expect(installButton?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      installButton!.click();
    });
    expect(vi.mocked(invoke).mock.calls.filter((call) => call[0] === "plugins_install")).toHaveLength(1);
  });

  it("drops a late Install or Not now once the folder has changed", async () => {
    let finishInstall: ((value: unknown) => void) | null = null;
    let finishDecline: ((value: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((command, args) => {
      const folder = args && "folder" in args ? String(args.folder) : "";
      if (command === "plugins_verify_offer") {
        return Promise.resolve(payload(folder.endsWith("other") ? { surfaces: ["mobile"], revision: 9 } : {}));
      }
      if (command === "plugins_install") return new Promise((resolve) => { finishInstall = resolve; });
      if (command === "plugins_verify_decline") return new Promise((resolve) => { finishDecline = resolve; });
      return Promise.resolve(undefined);
    });
    await show();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    await show("/code/other");
    await act(async () => {
      finishInstall?.({ status: "waiting", request: { steps: [] } });
    });
    expect(container.querySelector("[data-verify-sentence]")?.textContent).toBe("This project looks like a mobile app.");
    expect(container.querySelector("[data-verify-status]")).toBeNull();
    const installButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Install");
    expect(installButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click();
    });
    await show(FOLDER);
    await act(async () => {
      finishDecline?.({ applied: true, offer: payload({ declined: true, revision: 4, surfaces: ["mobile"] }) });
    });
    expect(container.querySelector("[data-verify-sentence]")?.textContent).toBe("This project looks like a web app.");
    expect(container.querySelector("[data-verify-offer]")).not.toBeNull();
  });

  it("hides the card when the person says not now", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_verify_offer") return payload();
      if (command === "plugins_verify_decline") return { applied: true, offer: payload({ declined: true, revision: 4 }) };
      return undefined;
    });
    await show();
    const notNow = [...container.querySelectorAll("button")].find((button) => button.textContent === "Not now");
    await act(async () => {
      notNow!.click();
    });
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls[calls.length - 1]).toEqual(["plugins_verify_decline", { folder: FOLDER, revision: 3 }]);
    expect(container.querySelector("[data-verify-offer]")).toBeNull();
  });

  it("keeps the card when the save lost a race or could not be read", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_verify_offer") return payload();
      if (command === "plugins_verify_decline") return { applied: false, offer: payload({ revision: 5 }) };
      return undefined;
    });
    await show();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click();
    });
    expect(container.querySelector("[data-verify-status]")?.textContent).toBe("Another window changed this. Try again.");
    expect(container.querySelector("[data-verify-offer]")).not.toBeNull();

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_verify_decline") return { applied: "yes" };
      return payload();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click();
    });
    expect(container.querySelector("[data-verify-status]")?.textContent).toBe("It wasn't saved. Try again.");
    expect(container.querySelector("[data-verify-offer]")).not.toBeNull();
  });

  it("ignores a late offer for a folder that is no longer shown", async () => {
    let settle: ((value: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "plugins_verify_offer") return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const folder = args && "folder" in args ? String(args.folder) : "";
        if (folder === FOLDER) settle = resolve;
        else resolve(payload({ surfaces: ["mobile"] }));
      });
    });
    await show();
    await show("/code/other");
    await act(async () => {
      settle?.(payload({ surfaces: ["web", "mobile"] }));
    });
    expect(container.querySelector("[data-verify-sentence]")?.textContent).toBe("This project looks like a mobile app.");
  });

  it("turns Verify on for this project only after it installs", async () => {
    let enableFails = true;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_verify_offer") return payload();
      if (command === "plugins_install") return { status: "installed", entry: { name: "e2e-verify" } };
      if (command === "plugins_enable") {
        if (enableFails) throw new Error("not yet");
        return { reports: [] };
      }
      return undefined;
    });
    await show();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    const enable = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "plugins_enable");
    expect(enable).toEqual([["plugins_enable", { name: "e2e-verify", project: FOLDER }]]);
    expect(container.querySelector("[data-verify-status]")?.textContent).not.toBe("Installed and on for this project.");
    expect(container.querySelector("[data-verify-offer]")).not.toBeNull();

    enableFails = false;
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Install")!.click();
    });
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls.filter((call) => call[0] === "plugins_install")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "plugins_enable")).toEqual([
      ["plugins_enable", { name: "e2e-verify", project: FOLDER }],
      ["plugins_enable", { name: "e2e-verify", project: FOLDER }],
    ]);
    expect(calls.some((call) => call[0] === "plugins_enable" && !(call[1] && "project" in (call[1] as object)))).toBe(false);
    expect(container.querySelector("[data-verify-status]")?.textContent).toBe("Installed and on for this project.");
  });

  it("turns Verify on for the project that was clicked when the folder changes", async () => {
    let finishInstall: ((value: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((command, args) => {
      const folder = args && "folder" in args ? String(args.folder) : "";
      if (command === "plugins_verify_offer") {
        return Promise.resolve(payload(folder.endsWith("other") ? { surfaces: ["mobile"], revision: 9 } : {}));
      }
      if (command === "plugins_install") return new Promise((resolve) => { finishInstall = resolve; });
      if (command === "plugins_enable") return Promise.resolve({ reports: [] });
      return Promise.resolve(undefined);
    });
    await show();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    await show("/code/other");
    await act(async () => {
      finishInstall?.({ status: "installed", entry: { name: "e2e-verify" } });
    });
    expect(vi.mocked(invoke).mock.calls.filter((call) => call[0] === "plugins_enable")).toEqual([
      ["plugins_enable", { name: "e2e-verify", project: FOLDER }],
    ]);
    expect(container.querySelector("[data-verify-status]")?.textContent ?? "").not.toBe("Installed and on for this project.");
    expect(container.querySelector("[data-verify-sentence]")?.textContent).toBe("This project looks like a mobile app.");
  });

  it("drops the installed note when the folder changes, even if the next offer fails", async () => {
    let failNext: ((reason: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((command, args) => {
      const folder = args && "folder" in args ? String(args.folder) : "";
      if (command === "plugins_verify_offer") {
        if (folder.endsWith("other")) return new Promise((_resolve, reject) => { failNext = reject; });
        return Promise.resolve(payload());
      }
      if (command === "plugins_install") return Promise.resolve({ status: "installed", entry: { name: "e2e-verify" } });
      if (command === "plugins_enable") return Promise.resolve({ reports: [] });
      return Promise.resolve(undefined);
    });
    await show();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector("[data-verify-status]")?.textContent).toBe("Installed and on for this project.");

    await show("/code/other");
    expect(container.textContent ?? "").not.toContain("Installed and on for this project.");

    await act(async () => {
      failNext?.(new Error("timed out"));
    });
    expect(container.textContent ?? "").not.toContain("Installed and on for this project.");
    expect(container.querySelector("[data-verify-offer]")).toBeNull();
  });

  it("shows nothing when the offer can't be fetched, and does not ask for a blank folder", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("timed out"));
    await show();
    expect(container.querySelector("[data-verify-offer]")).toBeNull();
    vi.mocked(invoke).mockClear();
    await show("   ");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
