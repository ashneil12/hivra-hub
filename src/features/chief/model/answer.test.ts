import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askChief, fileIntoProject, linesFromReply, type Reading } from "./answer";

const readings: Reading[] = [
  { kind: "task", id: "task-1", projectId: "crew", text: "Write the notes", stuck: false },
  { kind: "task", id: "task-2", projectId: "site", text: "Home page", stuck: true },
  { kind: "doc", id: "doc-1", projectId: "crew", text: "Crew plan", stuck: false },
  { kind: "decision", id: "ship", projectId: "crew", text: "Should we ship?", stuck: false },
];

const projects = [
  { id: "crew", name: "Crew", folder: null },
  { id: "site", name: "Site", folder: null },
];

describe("askChief", () => {
  it("answers the three questions only from what was read", () => {
    const happening = askChief("What's happening?", { readings, projects, loaded: true });
    expect(happening.kind).toBe("lines");
    if (happening.kind !== "lines") return;
    expect(happening.lines.map((line) => line.id)).toEqual(["task-1", "task-2", "doc-1", "ship"]);
    expect(happening.lines[0].text).toBe("Crew · Write the notes");

    const stuck = askChief("What's stuck?", { readings, projects, loaded: true });
    expect(stuck).toMatchObject({ kind: "lines", lines: [{ id: "task-2", kind: "task" }] });

    const decided = askChief("What did we decide about ship?", { readings, projects, loaded: true });
    expect(decided).toMatchObject({ kind: "lines", lines: [{ id: "ship", kind: "decision" }] });
    expect(askChief("What did we decide about fonts?", { readings, projects, loaded: true })).toMatchObject({ kind: "lines", lines: [] });
  });

  it("says there are no projects instead of asking which one, when there are none", () => {
    expect(askChief("Write the notes", { readings: [], projects: [], loaded: true })).toEqual({
      kind: "question",
      text: "There are no projects yet. Add one first, then tell it what to do.",
    });
  });

  it("does not answer as if nothing is going on when the read has not landed", () => {
    expect(askChief("What's going on?", { readings: [], projects, loaded: false })).toEqual({
      kind: "question",
      text: "I couldn't read that just now. Try again.",
    });
  });

  it("files into the named project, asks once when it cannot tell, and does not start the work", () => {
    expect(askChief("Have Crew write the notes", { readings, projects, loaded: true })).toEqual({
      kind: "file",
      projectId: "crew",
      title: "Have Crew write the notes",
    });
    expect(askChief("Write the notes", { readings, projects, loaded: true })).toEqual({
      kind: "question",
      text: "Which project should this go in?",
    });
    expect(askChief("Have Crew and Site write the notes", { readings, projects, loaded: true })).toEqual({
      kind: "question",
      text: "Which project should this go in?",
    });
    expect(askChief("  ", { readings, projects, loaded: true }).kind).toBe("question");
  });

  it("names a project only as a whole word, not a piece of a longer one", () => {
    const ask = (text: string, extra: { id: string; name: string; folder: null }[] = []) =>
      askChief(text, { readings, projects: [...projects, ...extra], loaded: true });
    expect(ask("Fix the screw")).toEqual({ kind: "question", text: "Which project should this go in?" });
    expect(ask("Rewrite the composite layout")).toEqual({ kind: "question", text: "Which project should this go in?" });
    expect(ask("Update the Sitemap")).toEqual({ kind: "question", text: "Which project should this go in?" });
    expect(ask("Crewman writes the notes")).toEqual({ kind: "question", text: "Which project should this go in?" });
    expect(ask("Put this on crew")).toEqual({ kind: "file", projectId: "crew", title: "Put this on crew" });
    expect(ask("Fix a.b please", [{ id: "a.b", name: "Dots", folder: null }])).toEqual({
      kind: "file",
      projectId: "a.b",
      title: "Fix a.b please",
    });
    expect(ask("Fix axb please", [{ id: "a.b", name: "Dots", folder: null }])).toEqual({
      kind: "question",
      text: "Which project should this go in?",
    });
    expect(ask("écrew stays put")).toEqual({ kind: "question", text: "Which project should this go in?" });
    expect(ask("Ask Müller", [{ id: "mu", name: "Müller", folder: null }])).toEqual({
      kind: "file",
      projectId: "mu",
      title: "Ask Müller",
    });
    expect(ask("Ask Müllerei", [{ id: "mu", name: "Müller", folder: null }])).toEqual({
      kind: "question",
      text: "Which project should this go in?",
    });
  });
});

describe("linesFromReply", () => {
  it("keeps a line only when every id on it was read", () => {
    const reply = ["task:task-1 is moving", "task:not-real was invented", "doc:doc-1 and task:missing", "doc:doc-1 the plan"].join("\n");
    expect(linesFromReply(reply, readings).map((line) => `${line.kind}:${line.id}`)).toEqual(["task:task-1", "doc:doc-1"]);
    expect(linesFromReply("nothing worth linking", readings)).toEqual([]);
  });
});

describe("fileIntoProject", () => {
  it("files with tasks.create and does not say it filed when the store rejects", async () => {
    const store = vi.fn(async () => ({ id: "task-9" }));
    await expect(fileIntoProject(store, "crew", "Write the notes")).resolves.toEqual({ ok: true, id: "task-9" });
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBe("tasks_create");
    store.mockRejectedValueOnce(new Error("timed out"));
    await expect(fileIntoProject(store, "crew", "Write the notes")).resolves.toEqual({
      ok: false,
      text: "Couldn't file that. Try again.",
    });
  });
});

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fake Claude", () => {
  it("links only the seeded tasks and docs, and drops an id the reply invented", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wp88-fake-"));
    scratches.push(dir);
    const scenario = path.join(dir, "rules.json");
    writeFileSync(scenario, JSON.stringify({
      version: 1,
      rules: [{
        name: "answer",
        match: "happening",
        steps: [{ say: "task:task-1 Write the notes\ntask:not-real I did not read this\ndoc:doc-1 Crew plan" }],
      }],
    }));
    const text = await fakeReply(dir, scenario, "What's happening?");
    expect(linesFromReply(text, readings).map((line) => line.id)).toEqual(["task-1", "doc-1"]);
    expect(text).toContain("not-real");
    expect(linesFromReply(text, readings).some((line) => line.id === "not-real")).toBe(false);
  }, 20_000);
});

function fakeReply(dir: string, scenario: string, prompt: string): Promise<string> {
  const fake = path.join(process.cwd(), "scripts/fake-claude.mjs");
  const child = spawn(process.execPath, [fake, "--output-format", "stream-json", "--input-format", "stream-json"], {
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_STATE: path.join(dir, "state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: { type?: string; message?: { content?: { type?: string; text?: string }[] } }[] = [];
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("fake claude timed out"));
    }, 15_000);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith("{")) return;
      frames.push(JSON.parse(line) as { type?: string });
      if (!frames.some((frame) => frame.type === "result")) return;
      clearTimeout(timer);
      const text = frames.flatMap((frame) => frame.message?.content ?? []).map((part) => part.text ?? "").join("\n");
      child.kill();
      resolve(text);
    });
    send({ type: "control_request", request_id: "monocode_2", request: { subtype: "initialize" } });
    setTimeout(() => {
      send({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
    }, 50);
  });
}
