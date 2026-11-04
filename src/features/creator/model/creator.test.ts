import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  creatorDraft,
  creatorStart,
  errorText,
  isLatest,
  readState,
  resetLatest,
  statusLine,
  takeLatest,
} from "./creator";

const invokeMock = vi.mocked(invoke);

function session(patch: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    view: "creator",
    revision: 1,
    phase: "drafted",
    plugin: "made-panel",
    expect: "panel",
    enabledGlobally: false,
    visibleHere: false,
    mcpApproved: false,
    mcpWaiting: false,
    scriptWaiting: false,
    reports: [{ path: "plugin.json", message: "Fine." }],
    panel: { id: "hello", title: "Hello", html: "<p>Hi</p>", css: "", js: "", permissions: [] },
    skills: ["greet"],
    mcpServers: [],
    mcpTools: [],
    mcpNote: null,
    ...patch,
  };
}

describe("readState", () => {
  it("keeps a session and drops a panel whose html isn't text", () => {
    const read = readState(session({ panel: { id: "hello", title: "Hello", html: 1 }, extra: true }));
    expect(read?.phase).toBe("drafted");
    expect(read?.panel).toBeNull();
    expect(read?.reports).toEqual([{ path: "plugin.json", message: "Fine." }]);
    expect(readState(session({ reports: [{ path: 1, message: "no" }, "bad"] }))?.reports).toEqual([]);
  });

  it("refuses a payload that isn't a session, and does not throw", () => {
    expect(readState(null)).toBeNull();
    expect(readState("nope")).toBeNull();
    expect(readState(session({ phase: "nope" }))).toBeNull();
    expect(readState(session({ id: "" }))).toBeNull();
    expect(readState(session({ revision: 1.5 }))).toBeNull();
    expect(readState(session({ view: 2 }))).toBeNull();
    expect(readState({ ...session(), phase: undefined })).toBeNull();
  });
});

describe("statusLine and a late click", () => {
  beforeEach(() => resetLatest());

  it("names each phase in the words the screen shows", () => {
    expect(statusLine("drafted")).toBe("Drafted. Nothing is installed yet.");
    expect(statusLine("previewed")).toBe("Only this view can see it.");
    expect(statusLine("kept")).toBe("Kept.");
    expect(statusLine("undone")).toBe("Rolled back.");
    expect(statusLine("discarded")).toBe("The scratch folder is gone.");
    expect(statusLine("started")).toBe("Started.");
    expect(statusLine("nope")).toBe("Started.");
  });

  it("treats only the newest click as current", () => {
    const first = takeLatest();
    const second = takeLatest();
    expect(isLatest(first)).toBe(false);
    expect(isLatest(second)).toBe(true);
  });

  it("says what failed, and falls back when there is nothing to say", () => {
    expect(errorText("  out of date  ")).toBe("out of date");
    expect(errorText(new Error("gone"))).toBe("gone");
    expect(errorText(new Error("  "))).toBe("That didn't work.");
    expect(errorText(12)).toBe("That didn't work.");
  });
});

describe("creator commands", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sends the revision it was given and refuses a reply that isn't a session", async () => {
    invokeMock.mockResolvedValueOnce(session());
    await creatorStart("panel");
    expect(invokeMock).toHaveBeenCalledWith("creator_start", { view: "creator", expect: "panel" });

    invokeMock.mockResolvedValueOnce(session({ revision: 2 }));
    const drafted = await creatorDraft("11111111-1111-4111-8111-111111111111", 1, [{ path: "plugin.json", content: "{}" }]);
    expect(drafted.revision).toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("creator_draft", {
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      files: [{ path: "plugin.json", content: "{}" }],
    });

    invokeMock.mockResolvedValueOnce({ phase: "kept" });
    await expect(creatorDraft("11111111-1111-4111-8111-111111111111", 2, [])).rejects.toThrow("That didn't work.");
  });
});
