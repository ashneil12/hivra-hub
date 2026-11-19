// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findProofTool, type ProofToolStatus } from "../model/proofTools";
import { NONE_FIT_LINE, PROOF_TOOLS_HINT } from "../model/proofToolsSettings";
import { ProofToolsSetting } from "./ProofToolsSetting";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const STALE = "That changed in another window. Look again, then set it.";

type Fit = { id: string; installed: boolean; status?: ProofToolStatus };
/** What the app keeps for one project: which tools fit, which are off and the switch revision. */
type Project = { fits: Fit[]; off: Set<string>; revision: number };

describe("Proof tools (Settings)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let projects: Map<string, Project>;

  // In the catalogue's order, which is the order the rows show in.
  const app: Fit[] = [
    { id: "fast-check", installed: true },
    { id: "stryker", installed: false, status: "proposed" },
    { id: "semgrep", installed: false, status: "declined" },
    { id: "playwright", installed: true },
  ];

  function wire(project: Project) {
    return {
      stacks: ["node", "web"],
      revision: project.revision,
      tools: project.fits.map((fit) => {
        const known = findProofTool(fit.id)!;
        return {
          id: fit.id,
          name: known.name,
          proves: known.proves,
          howToUse: known.howToUse,
          kind: known.kind,
          external: known.external,
          installed: fit.installed,
          status: fit.status ?? "open",
          off: fit.installed && project.off.has(fit.id),
        };
      }),
    };
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    projects = new Map([["/work/app", { fits: app, off: new Set(), revision: 0 }]]);
    vi.mocked(openUrl).mockClear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(fakeApp);
  });

  /** The app's answers: one record per project, a write on an old revision refused. */
  async function fakeApp(command: string, args?: unknown): Promise<unknown> {
    const { folder, toolId, on, expectedRevision } = (args ?? {}) as { folder: string; toolId?: string; on?: boolean; expectedRevision?: number };
    const project = projects.get(folder) ?? { fits: [], off: new Set<string>(), revision: 0 };
    if (command === "proof_tools_list") return wire(project);
    if (command === "proof_tools_set") {
      if (expectedRevision !== project.revision) throw STALE;
      if (on) project.off.delete(toolId!);
      else project.off.add(toolId!);
      project.revision += 1;
      projects.set(folder, project);
      return { off: [...project.off], revision: project.revision };
    }
    throw new Error(command);
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function show(props: { project: string; home?: boolean; recents?: { path: string }[] }) {
    await act(async () => {
      root.render(createElement(ProofToolsSetting, { home: false, ...props }));
    });
  }

  const row = (id: string) => container.querySelector<HTMLElement>(`[data-proof-tool='${id}']`);
  const ids = () => [...container.querySelectorAll("[data-proof-tool]")].map((el) => el.getAttribute("data-proof-tool"));
  const state = (id: string) => container.querySelector(`[data-proof-tool-state='${id}']`)?.textContent ?? null;
  const tag = (id: string) => row(id)?.querySelector("[data-proof-tool-tag]")?.textContent ?? null;
  const toggle = (id: string) => container.querySelector<HTMLButtonElement>(`[data-proof-tool-switch='${id}']`);
  const more = (id: string) => container.querySelector<HTMLButtonElement>(`[data-proof-tool-more='${id}']`);
  const details = (id: string) => document.body.querySelector<HTMLElement>(`[data-proof-tool-details='${id}']`);
  const note = () => container.querySelector("[data-proof-tools-note]")?.textContent ?? null;
  const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

  async function flip(id: string) {
    await act(async () => {
      toggle(id)?.click();
    });
  }

  async function openMore(id: string) {
    await act(async () => {
      more(id)?.click();
    });
  }

  it("lists the tools that fit, in order, each with what it proves in full", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(ids()).toEqual(["fast-check", "stryker", "semgrep", "playwright"]));
    for (const { id } of app) {
      const known = findProofTool(id)!;
      expect(row(id)?.textContent).toContain(known.name);
      // The line under the name is the catalogue's, whole, with no clip.
      const proves = [...row(id)!.querySelectorAll("p")].find((el) => el.textContent === known.proves);
      expect(proves, id).toBeDefined();
      expect(proves?.className).not.toMatch(/truncate|line-clamp|text-ellipsis|overflow-hidden/);
    }
    const section = container.querySelector("[data-setting-id='proof-tools']");
    expect(section?.getAttribute("id")).toBe("setting-proof-tools");
    expect(section?.getAttribute("aria-label")).toBe("Proof tools");
    expect(section?.querySelector("h3")?.textContent).toBe("Proof tools");
    expect(container.querySelector("[data-proof-tools-hint]")?.textContent).toBe(PROOF_TOOLS_HINT);
    expect(container.textContent).toContain("For app.");
    expect(container.textContent).not.toMatch(/[—–]|Stuck|\bMono\b/);
    expect(calls("proof_tools_list")).toEqual([["proof_tools_list", { folder: "/work/app" }]]);
    // Looking writes nothing.
    expect(calls("proof_tools_set")).toEqual([]);
  });

  it("lists only what the app says fits: a tool it left out is not there", async () => {
    projects.set("/work/app", { fits: [{ id: "proptest", installed: false }], off: new Set(), revision: 0 });
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(ids()).toEqual(["proptest"]));
    expect(row("fast-check")).toBeNull();
    expect(container.querySelector("[data-proof-tools-none]")).toBeNull();
  });

  it("says in one grey line when nothing fits", async () => {
    projects.set("/work/app", { fits: [], off: new Set(), revision: 0 });
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(container.querySelector("[data-proof-tools-none]")).not.toBeNull());
    const none = container.querySelector("[data-proof-tools-none]");
    expect(none?.textContent).toBe(NONE_FIT_LINE);
    expect(none?.className).toContain("text-content/60");
    expect(ids()).toEqual([]);
    expect(container.querySelector("[data-proof-tools-hint]")?.textContent).toBe(PROOF_TOOLS_HINT);
  });

  it("shows Used, Not in this project and Off, and Proposed or Declined as a small tag for a tool the project lacks", async () => {
    projects.get("/work/app")!.off.add("playwright");
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(ids()).toHaveLength(4));
    expect(state("fast-check")).toBe("Used");
    expect(state("stryker")).toBe("Not in this project");
    expect(state("playwright")).toBe("Off");
    expect(state("semgrep")).toBe("Not in this project");
    expect(tag("stryker")).toBe("Proposed");
    expect(tag("semgrep")).toBe("Declined");
    expect(tag("fast-check")).toBeNull();
    expect(tag("playwright")).toBeNull();
    expect(row("stryker")?.querySelector("[data-proof-tool-tag]")?.className).toContain("text-[11px]");
  });

  it("gives an installed tool a switch named for it and a tool the project lacks none", async () => {
    projects.get("/work/app")!.off.add("playwright");
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(ids()).toHaveLength(4));
    expect(toggle("fast-check")?.getAttribute("role")).toBe("switch");
    expect(toggle("fast-check")?.getAttribute("aria-label")).toBe("Use fast-check in this project");
    expect(toggle("playwright")?.getAttribute("aria-label")).toBe("Use Playwright in this project");
    expect(toggle("fast-check")?.getAttribute("aria-checked")).toBe("true");
    expect(toggle("playwright")?.getAttribute("aria-checked")).toBe("false");
    expect(toggle("stryker")).toBeNull();
    expect(toggle("semgrep")).toBeNull();
    expect(container.querySelectorAll("[role='switch']")).toHaveLength(2);
  });

  it("writes the switch on top of the revision it last read, shows the tool Off and writes the next one on the new revision", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(toggle("fast-check")).not.toBeNull());
    await flip("fast-check");
    await vi.waitFor(() => expect(state("fast-check")).toBe("Off"));
    expect(calls("proof_tools_set")[0]).toEqual([
      "proof_tools_set",
      { folder: "/work/app", toolId: "fast-check", on: false, expectedRevision: 0 },
    ]);
    expect(toggle("fast-check")?.getAttribute("aria-checked")).toBe("false");
    expect(state("playwright")).toBe("Used");
    expect(note()).toBeNull();
    // Turning it back on is the next write, on the revision the app handed back.
    await flip("fast-check");
    await vi.waitFor(() => expect(state("fast-check")).toBe("Used"));
    expect(calls("proof_tools_set")[1]?.[1]).toEqual({ folder: "/work/app", toolId: "fast-check", on: true, expectedRevision: 1 });
    expect(projects.get("/work/app")?.revision).toBe(2);
    expect(projects.get("/work/app")?.off.size).toBe(0);
  });

  it("holds every switch while a write is out, with the new position showing, and takes no second write", async () => {
    let finish: (value: unknown) => void = () => {};
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(toggle("fast-check")).not.toBeNull());
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "proof_tools_set") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return wire(projects.get("/work/app")!);
    });
    await flip("fast-check");
    expect(toggle("fast-check")?.getAttribute("aria-checked")).toBe("false");
    expect(toggle("fast-check")?.disabled).toBe(true);
    expect(toggle("playwright")?.disabled).toBe(true);
    await flip("playwright");
    expect(calls("proof_tools_set")).toHaveLength(1);
    await act(async () => {
      finish({ off: ["fast-check"], revision: 1 });
    });
    expect(state("fast-check")).toBe("Off");
    expect(toggle("playwright")?.disabled).toBe(false);
  });

  it("says so in one grey line when another window changed it, and shows what is stored now", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(toggle("fast-check")).not.toBeNull());
    // Another window switches Playwright off after this one read.
    const project = projects.get("/work/app")!;
    project.off.add("playwright");
    project.revision = 5;
    await flip("fast-check");
    await vi.waitFor(() => expect(note()).toBe(STALE));
    // What shows is what the app holds, not what was clicked.
    await vi.waitFor(() => expect(state("playwright")).toBe("Off"));
    expect(state("fast-check")).toBe("Used");
    expect(toggle("fast-check")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-proof-tools-note]")?.className).toContain("text-content/60");
    expect(container.querySelector("[data-proof-tools-retry]")).toBeNull();
    // The next write is based on the revision it just read, and goes through.
    await flip("fast-check");
    await vi.waitFor(() => expect(state("fast-check")).toBe("Off"));
    const writes = calls("proof_tools_set");
    expect(writes[writes.length - 1]?.[1]).toMatchObject({ toolId: "fast-check", on: false, expectedRevision: 5 });
    expect(note()).toBeNull();
  });

  it("keeps what was stored when a write fails, says it didn't go through, and lets the person try again", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(toggle("fast-check")).not.toBeNull());
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "proof_tools_set") throw new Error("timed out");
      return wire(projects.get("/work/app")!);
    });
    await flip("fast-check");
    await vi.waitFor(() => expect(note()).toBe("That didn't go through. Try again."));
    expect(state("fast-check")).toBe("Used");
    // A timeout is not final: the switch is there to use again.
    expect(toggle("fast-check")?.disabled).toBe(false);
  });

  it("opens More with the licence, the repo, whether it needs a model, and no install line for a tool the project has", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("fast-check")).not.toBeNull());
    expect(more("fast-check")?.textContent).toBe("More");
    expect(details("fast-check")).toBeNull();
    await openMore("fast-check");
    const open = details("fast-check");
    expect(open).not.toBeNull();
    expect(open?.textContent).toContain("MIT licence");
    expect(open?.textContent).toContain("github.com/dubzzz/fast-check");
    expect(open?.textContent).toContain("Needs no model");
    expect(open?.textContent).not.toContain("Your first mate can add this for you");
    expect(open?.textContent).not.toContain("npm install");
    expect(open?.textContent).not.toContain("never bundles");
    // Opening it writes nothing.
    expect(calls("proof_tools_set")).toEqual([]);
  });

  it("opens the repo in the browser through the app", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("fast-check")).not.toBeNull());
    await openMore("fast-check");
    const link = document.body.querySelector<HTMLButtonElement>("[data-proof-tool-repo='fast-check']");
    expect(link?.textContent).toBe("github.com/dubzzz/fast-check");
    await act(async () => {
      link?.click();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/dubzzz/fast-check");
  });

  it("says when the browser would not open, and keeps the popover", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no browser"));
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("fast-check")).not.toBeNull());
    await openMore("fast-check");
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>("[data-proof-tool-repo='fast-check']")?.click();
    });
    await vi.waitFor(() => expect(note()).toBe("That didn't go through. Try again."));
  });

  it("for a tool the project lacks, More gives the install command as plain text and says the first mate asks first", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("stryker")).not.toBeNull());
    await openMore("stryker");
    const open = details("stryker");
    expect(open?.textContent).toContain("Apache 2.0 licence");
    expect(open?.textContent).toContain(findProofTool("stryker")!.install);
    expect(open?.textContent).toContain("Your first mate can add this for you; it asks you first.");
    expect(open?.querySelector("a")).toBeNull();
  });

  it("for an external tool, More says it runs only if it is installed and is never bundled or installed by the app", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("semgrep")).not.toBeNull());
    await openMore("semgrep");
    const open = details("semgrep");
    expect(open?.textContent).toContain("LGPL 2.1 or later licence");
    expect(open?.textContent).toContain("Runs only if you have it installed. The app never bundles or installs it.");
    expect(open?.textContent).toContain(findProofTool("semgrep")!.install);
    // A tool that is not external never says it.
    await act(async () => {
      more("semgrep")?.click();
    });
    expect(details("semgrep")).toBeNull();
    await openMore("stryker");
    expect(details("stryker")?.textContent).not.toContain("never bundles");
  });

  it("closes More on Escape and on a click outside", async () => {
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(more("fast-check")).not.toBeNull());
    await openMore("fast-check");
    expect(details("fast-check")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(details("fast-check")).toBeNull();
    await openMore("fast-check");
    expect(details("fast-check")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(details("fast-check")).toBeNull();
  });

  it("ignores a late read from the project it left", async () => {
    let release: (value: unknown) => void = () => {};
    projects.set("/work/two", { fits: [{ id: "proptest", installed: true }], off: new Set(), revision: 0 });
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === "proof_tools_list" && (args as { folder: string }).folder === "/work/one") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return fakeApp(command, args);
    });
    await show({ project: "/work/one" });
    expect(ids()).toEqual([]);
    expect(container.textContent).toContain("Reading what one has.");
    await show({ project: "/work/two" });
    await vi.waitFor(() => expect(ids()).toEqual(["proptest"]));
    await act(async () => {
      release(wire({ fits: app, off: new Set(), revision: 9 }));
    });
    expect(ids()).toEqual(["proptest"]);
    expect(container.textContent).toContain("For two.");
  });

  it("ignores a late write from the project it left", async () => {
    let finish: (value: unknown) => void = () => {};
    projects.set("/work/two", { fits: [{ id: "proptest", installed: true }], off: new Set(), revision: 0 });
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === "proof_tools_set") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return fakeApp(command, args);
    });
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(toggle("fast-check")).not.toBeNull());
    await flip("fast-check");
    await show({ project: "/work/two" });
    await vi.waitFor(() => expect(ids()).toEqual(["proptest"]));
    await act(async () => {
      finish({ off: ["fast-check"], revision: 1 });
    });
    expect(ids()).toEqual(["proptest"]);
    expect(state("proptest")).toBe("Used");
    expect(toggle("proptest")?.disabled).toBe(false);
  });

  it("says when it can't read, and reads again on Try again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("That folder isn't on this computer.");
    await show({ project: "/work/app" });
    await vi.waitFor(() => expect(note()).toContain("That folder isn't on this computer."));
    expect(ids()).toEqual([]);
    expect(container.querySelector("[data-proof-tools-none]")).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>("[data-proof-tools-retry]");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => {
      retry?.click();
    });
    await vi.waitFor(() => expect(ids()).toHaveLength(4));
    expect(note()).toBeNull();
  });

  it("asks nothing and shows no rows with no project open", async () => {
    await show({ project: "" });
    expect(container.textContent).toContain("Open a project to see which of these tools fit it.");
    expect(container.querySelector("[data-proof-tools-hint]")?.textContent).toBe(PROOF_TOOLS_HINT);
    expect(ids()).toEqual([]);
    expect(container.querySelector("[data-proof-tools-none]")).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(container.querySelector("[data-setting-id='proof-tools']")).not.toBeNull();
  });

  it("from Home asks for a project first and reads nothing until one is picked", async () => {
    await show({ project: "/work/last-project", home: true, recents: [{ path: "/work/other" }] });
    expect(container.textContent).toContain("Pick a project to see which of these tools fit it.");
    expect(container.querySelector("[data-proof-tools-project]")).not.toBeNull();
    expect(container.textContent).toContain("Choose a project");
    expect(ids()).toEqual([]);
    expect(container.querySelector("[data-proof-tools-none]")).toBeNull();
    // The project Home was last in is not read for it.
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(container.querySelector("[data-setting-id='proof-tools']")).not.toBeNull();
  });
});
