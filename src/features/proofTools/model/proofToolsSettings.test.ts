import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { KNOWN_LICENCES, PROOF_TOOLS, findProofTool, type ProofToolList, type ProofToolView } from "./proofTools";
import {
  NONE_FIT_LINE,
  PROOF_TOOLS_HINT,
  PROOF_TOOLS_TRY_AGAIN,
  applySwitches,
  failureLine,
  licenceWords,
  loadProofTools,
  moreLines,
  readSwitches,
  repoLabel,
  setProofTool,
  stateWord,
  tagOf,
} from "./proofToolsSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const STALE = "That changed in another window. Look again, then set it.";

function view(id: string, over: Partial<ProofToolView> = {}): ProofToolView {
  const known = findProofTool(id)!;
  return {
    id,
    name: known.name,
    proves: known.proves,
    howToUse: known.howToUse,
    kind: known.kind,
    external: known.external,
    installed: false,
    status: "open",
    off: false,
    ...over,
  };
}

/** What `proof_tools_list` answers on the wire. */
function wire(tools: ProofToolView[], revision = 0) {
  return { stacks: ["node"], tools, revision };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the words", () => {
  it("say what the section is in the spec's own sentence, and what an empty list is", () => {
    expect(PROOF_TOOLS_HINT).toBe(
      "Open-source tools that check the work. Each one this project has is on until you switch it off, and the app never installs one by itself.",
    );
    expect(NONE_FIT_LINE).toBe("None of these tools fit this project.");
    expect(PROOF_TOOLS_TRY_AGAIN).toBe("That didn't go through. Try again.");
  });
});

describe("failureLine", () => {
  it("is the app's own plain words when it gave some, else the usual line", () => {
    expect(failureLine(STALE)).toBe(STALE);
    expect(failureLine("  Another window is saving this. Try again.  ")).toBe("Another window is saving this. Try again.");
    // An error thrown on this side ("timed out", a stack) is not words for a person.
    for (const nothing of ["", "   ", null, undefined, 7, {}, new Error(""), new Error("timed out")]) {
      expect(failureLine(nothing), String(nothing)).toBe(PROOF_TOOLS_TRY_AGAIN);
    }
  });
});

describe("loadProofTools", () => {
  it("asks the app about the folder and reads what it says, with the revision a write is based on", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(wire([view("fast-check", { installed: true }), view("stryker", { status: "proposed" })], 4));
    const list = await loadProofTools("/work/app");
    expect(invoke).toHaveBeenCalledWith("proof_tools_list", { folder: "/work/app" });
    expect(list.revision).toBe(4);
    expect(list.tools.map((tool) => [tool.id, tool.installed, tool.status, tool.off])).toEqual([
      ["fast-check", true, "open", false],
      ["stryker", false, "proposed", false],
    ]);
  });

  it("throws the app's line when the call fails, and the usual line for an answer it can't read", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("That folder isn't on this computer.");
    await expect(loadProofTools("/gone")).rejects.toThrow("That folder isn't on this computer.");
    vi.mocked(invoke).mockRejectedValueOnce("");
    await expect(loadProofTools("/x")).rejects.toThrow(PROOF_TOOLS_TRY_AGAIN);
    vi.mocked(invoke).mockResolvedValueOnce({ nope: true });
    await expect(loadProofTools("/x")).rejects.toThrow(PROOF_TOOLS_TRY_AGAIN);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(loadProofTools("/x")).rejects.toThrow(PROOF_TOOLS_TRY_AGAIN);
  });
});

describe("setProofTool", () => {
  it("writes on top of the revision last read and reads the answer", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ off: ["stryker", "fast-check"], revision: 5 });
    const answer = await setProofTool("/work/app", "fast-check", false, 4);
    expect(invoke).toHaveBeenCalledWith("proof_tools_set", { folder: "/work/app", toolId: "fast-check", on: false, expectedRevision: 4 });
    expect(answer).toEqual({ off: ["fast-check", "stryker"], revision: 5 });
  });

  it("throws a refusal as the app says it, and the usual line when the answer is unreadable", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(STALE);
    await expect(setProofTool("/work/app", "fast-check", true, 1)).rejects.toThrow(STALE);
    for (const bad of [null, "ok", { off: "x", revision: 1 }, { off: [], revision: -1 }, { off: [], revision: "1" }, { revision: 1 }]) {
      vi.mocked(invoke).mockResolvedValueOnce(bad);
      await expect(setProofTool("/work/app", "fast-check", true, 1), JSON.stringify(bad)).rejects.toThrow(PROOF_TOOLS_TRY_AGAIN);
    }
  });
});

describe("readSwitches", () => {
  it("keeps only tools the catalogue knows, once each, in the catalogue's order", () => {
    expect(readSwitches({ off: ["stryker", "nope", 3, "fast-check", "stryker"], revision: 0 })).toEqual({ off: ["fast-check", "stryker"], revision: 0 });
    expect(readSwitches({ off: [], revision: 2 })).toEqual({ off: [], revision: 2 });
  });
});

describe("a row's state", () => {
  it("is Used for an installed tool that is on, Off for one switched off, and Not in this project for one it lacks", () => {
    expect(stateWord(view("fast-check", { installed: true }))).toBe("Used");
    expect(stateWord(view("fast-check", { installed: true, off: true }))).toBe("Off");
    expect(stateWord(view("stryker"))).toBe("Not in this project");
    // A switch on a tool the project doesn't have changes nothing about what it is.
    expect(stateWord(view("stryker", { off: true }))).toBe("Not in this project");
    expect(stateWord(view("stryker", { status: "declined" }))).toBe("Not in this project");
  });

  it("carries Proposed or Declined as a tag only while the project lacks the tool", () => {
    expect(tagOf(view("stryker", { status: "proposed" }))).toBe("Proposed");
    expect(tagOf(view("stryker", { status: "declined" }))).toBe("Declined");
    expect(tagOf(view("stryker"))).toBeNull();
    // Installed since: the proposal record is history, not a state.
    expect(tagOf(view("stryker", { installed: true, status: "proposed" }))).toBeNull();
    expect(tagOf(view("stryker", { installed: true, status: "declined" }))).toBeNull();
  });
});

describe("applySwitches", () => {
  const list: ProofToolList = {
    stacks: ["node"],
    revision: 3,
    tools: [view("fast-check", { installed: true }), view("stryker", { installed: true, off: true }), view("playwright")],
  };

  it("sets the switch of each installed tool from the answer and takes the new revision", () => {
    const next = applySwitches(list, { off: ["fast-check", "playwright"], revision: 4 });
    expect(next.revision).toBe(4);
    expect(next.tools.map((tool) => [tool.id, tool.off])).toEqual([
      ["fast-check", true],
      ["stryker", false],
      // Not installed: it has no switch to show.
      ["playwright", false],
    ]);
    // The list it was given is not changed.
    expect(list.tools[0].off).toBe(false);
    expect(list.revision).toBe(3);
  });
});

describe("licenceWords", () => {
  it("gives every licence the catalogue knows plain words ending in licence", () => {
    expect(licenceWords("MIT")).toBe("MIT licence");
    expect(licenceWords("Apache-2.0")).toBe("Apache 2.0 licence");
    expect(licenceWords("MIT OR Apache-2.0")).toBe("MIT or Apache 2.0 licence");
    expect(licenceWords("MPL-2.0")).toBe("MPL 2.0 licence");
    expect(licenceWords("BSD-3-Clause")).toBe("BSD 3-clause licence");
    expect(licenceWords("LGPL-2.1-or-later")).toBe("LGPL 2.1 or later licence");
    for (const spdx of KNOWN_LICENCES) expect(licenceWords(spdx), spdx).toMatch(/ licence$/);
    // No SPDX spelling is left in what a person reads: no "OR", no "-or-later", no "Apache-2.0".
    for (const tool of PROOF_TOOLS) expect(licenceWords(tool.licence), tool.id).not.toMatch(/\bOR\b|-or-|[A-Za-z]-\d/);
  });

  it("says an unknown licence as it is written, and never nothing", () => {
    expect(licenceWords("WTFPL")).toBe("WTFPL licence");
    expect(licenceWords("  ")).toBe("Licence not stated");
  });
});

describe("repoLabel", () => {
  it("is the address without the scheme or a closing slash", () => {
    expect(repoLabel("https://github.com/dubzzz/fast-check")).toBe("github.com/dubzzz/fast-check");
    expect(repoLabel("https://github.com/a/b/")).toBe("github.com/a/b");
  });
});

describe("moreLines", () => {
  it("for a tool the project has: licence, repo and whether it needs a model, no install line", () => {
    const tool = findProofTool("fast-check")!;
    const lines = moreLines(tool, true);
    expect(lines).toEqual({
      licence: "MIT licence",
      repo: "https://github.com/dubzzz/fast-check",
      repoLabel: "github.com/dubzzz/fast-check",
      needs: "Needs no model",
      external: null,
      install: null,
    });
  });

  it("says a tool that uses a model uses one", () => {
    const tool = { ...findProofTool("fast-check")!, needsModel: true };
    expect(moreLines(tool, true).needs).toBe("Uses a model");
  });

  it("for a tool the project lacks: the install command as plain text and who can add it", () => {
    const tool = findProofTool("stryker")!;
    const lines = moreLines(tool, false);
    expect(lines.install).toEqual({ command: tool.install, note: "Your first mate can add this for you; it asks you first." });
    expect(lines.external).toBeNull();
  });

  it("for an external tool: it runs only if you have it, and the app never bundles or installs it", () => {
    const tool = findProofTool("semgrep")!;
    expect(moreLines(tool, true).external).toBe("Runs only if you have it installed. The app never bundles or installs it.");
    expect(moreLines(tool, true).install).toBeNull();
    const lacking = moreLines(tool, false);
    expect(lacking.external).toBe("Runs only if you have it installed. The app never bundles or installs it.");
    expect(lacking.install?.command).toBe(tool.install);
    expect(lacking.licence).toBe("LGPL 2.1 or later licence");
  });

  it("only ever links an https address", () => {
    for (const tool of PROOF_TOOLS) expect(moreLines(tool, false).repo.startsWith("https://"), tool.id).toBe(true);
  });
});
