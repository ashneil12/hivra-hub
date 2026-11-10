import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultBaseUrl } from "../../../features/sessions/model/customModels";
import {
  loadTextGeneration,
  saveTextGeneration,
  TEXT_GENERATION_KEY,
} from "../../../features/settings/model/textGeneration";
import {
  TextGenerationError,
  useTextGenerationPort,
  type TextGenerationRequest,
} from "../../../features/settings/model/textGenerationClient";
import {
  generateBranchWithTextModel,
  generateCommitMessage,
  generatePrContent,
  generateTitleWithTextModel,
} from "./textHarness";

const harnessCommit = vi.hoisted(() => vi.fn(async () => "from the coding agent"));
const harnessPr = vi.hoisted(() =>
  vi.fn(async () => ({ title: "CLI title", body: "CLI body", base: "cli-base", head: "cli-head" })),
);
const harnessTitle = vi.hoisted(() => vi.fn(async () => ({ title: "CLI title", workItem: null })));
const harnessBranch = vi.hoisted(() => vi.fn(async () => "cli-branch"));
const staged = vi.hoisted(() =>
  vi.fn(async (_cwd: string, paths?: readonly string[]) => ({
    branch: "feature",
    summary: paths ? "chosen.txt | 1 +" : "all.txt | 1 +",
    patch: paths ? "SELECTED_CONTENT" : "WHOLE_INDEX\r\nsecond",
  })),
);
const range = vi.hoisted(() =>
  vi.fn(async () => ({
    base: "main",
    head: "feature",
    commitSummary: "one commit",
    diffSummary: "1 file",
    diffPatch: "DIFF",
  })),
);

vi.mock("./availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("./registry", () => ({
  generateHarnessCommitMessage: harnessCommit,
  generateHarnessPrContent: harnessPr,
  generateHarnessTitle: harnessTitle,
  generateHarnessBranchName: harnessBranch,
  warmupHarnessText: vi.fn(),
}));
vi.mock("../../../platform/tauri/fs", () => ({
  gitStagedContext: staged,
  gitRangeContext: range,
}));

const setting = {
  provider: "openrouter" as const,
  model: "google/gemini-2.0-flash",
  baseUrl: defaultBaseUrl("openrouter"),
};

function mockStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
}

function armModel() {
  saveTextGeneration(setting);
  localStorage.setItem(
    "monocode:custom-models",
    JSON.stringify([
      {
        id: "or-1",
        name: "Flash",
        provider: "openrouter",
        baseUrl: setting.baseUrl,
        modelId: setting.model,
      },
    ]),
  );
}

function portReturning(reply: string | ((request: TextGenerationRequest) => Promise<string>)) {
  const calls: TextGenerationRequest[] = [];
  const port = {
    complete: (request: TextGenerationRequest) => {
      calls.push(request);
      return Promise.resolve(typeof reply === "function" ? reply(request) : reply);
    },
    writeFile: () => {
      throw new Error("the generator tried to write a file");
    },
  };
  useTextGenerationPort(port);
  return { calls, port };
}

const titleInput = {
  sessionId: "s1",
  cwd: "C:\\Users\\a b\\..\\repo",
  message: "Please fix the login",
};

beforeEach(() => {
  mockStorage();
  saveTextGeneration(null);
  vi.clearAllMocks();
});

afterEach(() => {
  useTextGenerationPort(null);
  saveTextGeneration(null);
});

it("keeps today's commit path when no text model is set", async () => {
  const { calls } = portReturning("should not be asked");
  const signal = new AbortController().signal;
  expect(await generateCommitMessage("/repo", "claude", signal, ["my file.txt"])).toBe("from the coding agent");
  expect(calls).toEqual([]);
  expect(staged).not.toHaveBeenCalled();
  expect(harnessCommit).toHaveBeenCalledExactlyOnceWith("claude", "/repo", signal, ["my file.txt"]);
});

it("uses the text model for a commit and does not start the coding agent", async () => {
  armModel();
  const { calls } = portReturning(JSON.stringify({ subject: "Add a title.", body: "more" }));
  expect(await generateCommitMessage("/repo", "claude", undefined, ["café.txt"])).toBe("Add a title\n\nmore");
  expect(harnessCommit).not.toHaveBeenCalled();
  expect(staged).toHaveBeenCalledExactlyOnceWith("/repo", ["café.txt"]);
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]!).sort()).toEqual(["baseUrl", "customModelId", "model", "prompt", "provider"]);
  expect(calls[0]).not.toHaveProperty("cwd");
  expect(calls[0]).not.toHaveProperty("tools");
  expect(JSON.stringify(calls[0])).not.toContain("/repo");
  expect(calls[0]?.prompt).toContain("SELECTED_CONTENT");
  expect(calls[0]?.prompt).toContain("Do not call tools");
});

it("falls back when the text model errors, and does not clear the setting", async () => {
  armModel();
  const { calls } = portReturning(async () => {
    throw new TextGenerationError("The model didn't answer this time. It can be tried again.", "timeout");
  });
  expect(await generateCommitMessage("/repo", "claude")).toBe("from the coding agent");
  expect(calls).toHaveLength(1);
  expect(harnessCommit).toHaveBeenCalledOnce();
  expect(loadTextGeneration()).toEqual(setting);
  expect(localStorage.getItem(TEXT_GENERATION_KEY)).toContain("openrouter");
});

it("falls back when the reply is not a commit message", async () => {
  armModel();
  portReturning("not json");
  expect(await generateCommitMessage("/repo", "claude")).toBe("from the coding agent");
  expect(harnessCommit).toHaveBeenCalledOnce();
});

it("falls back when git cannot be read, and does not ask the model", async () => {
  armModel();
  staged.mockRejectedValueOnce(new Error("git is down"));
  const { calls } = portReturning("nope");
  expect(await generateCommitMessage("/repo", "claude")).toBe("from the coding agent");
  expect(calls).toEqual([]);
  expect(harnessCommit).toHaveBeenCalledOnce();
});

it("does not fall back when the commit ask is cancelled", async () => {
  armModel();
  const controller = new AbortController();
  controller.abort();
  const { calls } = portReturning("nope");
  await expect(generateCommitMessage("/repo", "claude", controller.signal, ["chosen.txt"])).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(calls).toEqual([]);
  expect(staged).not.toHaveBeenCalled();
  expect(harnessCommit).not.toHaveBeenCalled();

  const late = new AbortController();
  let release: (value: string) => void = () => {};
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  useTextGenerationPort({ complete: () => pending });
  const running = generateCommitMessage("C:\\Users\\a b\\..\\repo", "claude", late.signal);
  await vi.waitFor(() => expect(staged).toHaveBeenCalled());
  late.abort();
  release(JSON.stringify({ subject: "Too late", body: "" }));
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  expect(harnessCommit).not.toHaveBeenCalled();
});

it("keeps both commit replies when two asks run together", async () => {
  armModel();
  let n = 0;
  portReturning(async () => {
    n += 1;
    const mine = n;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return JSON.stringify({ subject: `Subject ${mine}`, body: "" });
  });
  const [first, second] = await Promise.all([
    generateCommitMessage("/repo", "claude"),
    generateCommitMessage("/repo", "claude"),
  ]);
  expect([first, second].sort()).toEqual(["Subject 1", "Subject 2"]);
  expect(harnessCommit).not.toHaveBeenCalled();
});

it("keeps today's pull request path when no text model is set", async () => {
  const { calls } = portReturning("nope");
  expect(await generatePrContent("/repo", "claude")).toEqual({
    title: "CLI title",
    body: "CLI body",
    base: "cli-base",
    head: "cli-head",
  });
  expect(calls).toEqual([]);
  expect(range).not.toHaveBeenCalled();
  expect(harnessPr).toHaveBeenCalledExactlyOnceWith("claude", "/repo");
});

it("takes the pull request title from the model and the branches from git", async () => {
  armModel();
  const { calls } = portReturning(
    JSON.stringify({ title: "Add text", body: "notes", base: "evil", head: "also-evil" }),
  );
  expect(await generatePrContent("C:\\Users\\a b\\..\\repo", "claude")).toEqual({
    title: "Add text",
    body: "notes",
    base: "main",
    head: "feature",
  });
  expect(harnessPr).not.toHaveBeenCalled();
  expect(calls[0]).not.toHaveProperty("cwd");
  expect(JSON.stringify(calls[0])).not.toContain("C:\\Users\\a b");
  expect(calls[0]?.prompt).toContain("DIFF");
});

it("falls back for a pull request when the model sends nothing usable", async () => {
  armModel();
  portReturning(async () => {
    throw new TextGenerationError("The model sent nothing back.", "empty");
  });
  expect(await generatePrContent("/repo", "claude")).toMatchObject({ title: "CLI title" });
  expect(harnessPr).toHaveBeenCalledOnce();
  expect(loadTextGeneration()).toEqual(setting);
});

it("keeps today's title and branch path when no text model is set", async () => {
  const { calls } = portReturning("nope");
  expect(await generateTitleWithTextModel("claude", titleInput)).toEqual({ title: "CLI title", workItem: null });
  expect(await generateBranchWithTextModel("cursor", titleInput.cwd, titleInput.message)).toBe("cli-branch");
  expect(calls).toEqual([]);
  expect(harnessTitle).toHaveBeenCalledExactlyOnceWith("claude", titleInput);
  expect(harnessBranch).toHaveBeenCalledExactlyOnceWith("cursor", titleInput.cwd, titleInput.message);
});

it("uses the text model for a title and a branch name, with no repo path", async () => {
  armModel();
  const { calls } = portReturning((request) =>
    Promise.resolve(
      request.prompt.includes("key: branch")
        ? JSON.stringify({ branch: "Add Text Model" })
        : JSON.stringify({ title: "Fix the login" }),
    ),
  );
  expect(await generateTitleWithTextModel("claude", titleInput)).toEqual({
    title: "Fix the login",
    workItem: null,
  });
  expect(await generateBranchWithTextModel("cursor", titleInput.cwd, "add a text model")).toBe("add-text-model");
  expect(harnessTitle).not.toHaveBeenCalled();
  expect(harnessBranch).not.toHaveBeenCalled();
  expect(calls).toHaveLength(2);
  for (const request of calls) {
    expect(request).not.toHaveProperty("cwd");
    expect(JSON.stringify(request)).not.toContain("C:\\Users\\a b");
  }
});

it("does not send a patch that contains a secret to the text model", async () => {
  armModel();
  staged.mockResolvedValueOnce({
    branch: "feature",
    summary: "a.txt",
    patch: "key sk-ant-api03-abcdefghijklmnopqrst",
  });
  const { calls } = portReturning("nope");
  expect(await generateCommitMessage("/repo", "claude")).toBe("from the coding agent");
  expect(calls).toEqual([]);
  expect(harnessCommit).toHaveBeenCalledOnce();
  expect(loadTextGeneration()).toEqual(setting);
});

it("falls back to the coding agent when the command refuses a patch with a plain assigned secret", async () => {
  // Rust is the one place that scans each diff line (text_generation.rs). Its refusal reaches the
  // generators as a refused error: the coding agent runs and the saved setting stays.
  for (const line of ["+DB_PASSWORD=correcthorsebatterystaple", "+SMTP_PASS=hunter"]) {
    armModel();
    harnessCommit.mockClear();
    staged.mockResolvedValueOnce({ branch: "feature", summary: "app.env", patch: `@@ -1 +1,2 @@\n+PORT=3000\n${line}` });
    const { calls } = portReturning(async () => {
      throw new TextGenerationError("That text contained a secret, so it was not sent.", "refused");
    });
    expect(await generateCommitMessage("/repo", "claude")).toBe("from the coding agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain(line);
    expect(harnessCommit).toHaveBeenCalledOnce();
    expect(loadTextGeneration()).toEqual(setting);
  }
});

it("falls back when the title model fails, including a local model with no saved key", async () => {
  saveTextGeneration({ provider: "ollama", model: "llama3.2", baseUrl: defaultBaseUrl("ollama") });
  const { calls } = portReturning(async () => {
    throw new TextGenerationError("The model didn't answer this time. It can be tried again.", "timeout");
  });
  expect(await generateTitleWithTextModel("claude", titleInput)).toEqual({ title: "CLI title", workItem: null });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.customModelId).toBe("");
  expect(harnessTitle).toHaveBeenCalledOnce();
  expect(loadTextGeneration()?.provider).toBe("ollama");
});
