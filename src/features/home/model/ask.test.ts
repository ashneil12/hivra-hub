import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Reading } from "../../chief/model/answer";
import { createHomeAsks } from "./ask";

const readings: Reading[] = [
  { kind: "task", id: "task-1", projectId: "crew", text: "Write the notes", stuck: false },
  { kind: "doc", id: "doc-1", projectId: "site", text: "Site spec", stuck: false },
];

const projects = [
  { id: "crew", name: "Crew", folder: null },
  { id: "site", name: "Site", folder: null },
];

const input = { readings, projects, loaded: true };

describe("createHomeAsks", () => {
  it("a late file does not replace a newer answer", async () => {
    let finishFirst: (value: { ok: true; id: string }) => void = () => undefined;
    let calls = 0;
    const gate = createHomeAsks(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) finishFirst = resolve;
          else resolve({ ok: true, id: "task-2" });
        }),
    );
    const first = gate.ask("Have Crew write the notes", input);
    const second = await gate.ask("What's happening?", input);
    expect(second?.notes?.map((note) => note.id)).toEqual(["task-1", "doc-1"]);
    expect(second?.text).toBeUndefined();
    finishFirst({ ok: true, id: "task-9" });
    await expect(first).resolves.toBeUndefined();
  });

  it("keeps the later file and drops the earlier one", async () => {
    let finishFirst: (value: { ok: true; id: string }) => void = () => undefined;
    let finishSecond: (value: { ok: true; id: string }) => void = () => undefined;
    let calls = 0;
    const gate = createHomeAsks(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) finishFirst = resolve;
          else finishSecond = resolve;
        }),
    );
    const first = gate.ask("Have Crew write the notes", input);
    const second = gate.ask("Have Site paint the door", input);
    finishSecond({ ok: true, id: "task-2" });
    await expect(second).resolves.toEqual({
      text: "Filed.",
      notes: [{ id: "task-2", kind: "task", text: "Have Site paint the door", projectId: "site" }],
    });
    finishFirst({ ok: true, id: "task-9" });
    await expect(first).resolves.toBeUndefined();
  });

  it("still files when nothing newer has been asked, and a rejection is not filed", async () => {
    const gate = createHomeAsks(async () => ({ ok: true, id: "task-9" }));
    await expect(gate.ask("Have Crew write the notes", input)).resolves.toEqual({
      text: "Filed.",
      notes: [{ id: "task-9", kind: "task", text: "Have Crew write the notes", projectId: "crew" }],
    });
    const rejected = createHomeAsks(async () => ({ ok: false, text: "Couldn't file that. Try again." }));
    await expect(rejected.ask("Have Crew write the notes", input)).resolves.toEqual({
      text: "Couldn't file that. Try again.",
    });
    const quiet = createHomeAsks(async () => ({ ok: true }));
    await expect(quiet.ask("What's happening?", { readings: [], projects, loaded: true })).resolves.toEqual({
      text: "Nothing to say.",
    });
  });

  it("is what Home uses for an ask", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../ui/HomeView.tsx"), "utf8");
    const start = src.indexOf("async function onAsk");
    const body = src.slice(start, src.indexOf("return (", start));
    expect(body).toContain("asks.current?.ask");
    expect(body).not.toContain("fileIntoProject");
  });
});
