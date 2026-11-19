import { describe, expect, it } from "vitest";
import type { ImportState } from "../model/runner";
import type { Group } from "../model/plan";
import { railCard, type LearnView } from "./importRail";

const base: ImportState = {
  phase: "idle", seen: 0, total: 0, missing: [], active: 0, links: 0, side: 0, groups: [], choices: null, toImport: 0, done: 0,
  imported: 0, alreadyHere: 0, oneShots: 0, failed: 0, cut: 0, projectsMade: 0, importedIds: [], importedFolders: [],
};
const idle: LearnView = { phase: "idle", read: 0, target: 0, proposals: [] };
const group = { key: "/p/app", chats: 1203 } as Group;

describe("the sidebar's setup card", () => {
  it("says nothing when the setup is not under way", () => {
    expect(railCard({ stage: "off", learn: false }, { ...base, phase: "importing" }, idle)).toBeNull();
  });

  it("follows the setup and calls the person back for its two parts", () => {
    expect(railCard({ stage: "sweep", learn: true }, { ...base, phase: "finding", seen: 1203 }, idle)).toMatchObject({ title: "Finding your past chats", line: "1,203 found so far", busy: true });
    const found = railCard({ stage: "choose", learn: true }, { ...base, phase: "ready", groups: [group] }, idle)!;
    expect(found).toMatchObject({ title: "Your chats are found", line: "1,203 chats. Choose what comes in", open: "choose", busy: false });
    expect(railCard({ stage: "importing", learn: true }, { ...base, phase: "importing", done: 40, toImport: 900 }, idle)).toMatchObject({ line: "40 of 900", busy: true });
    expect(railCard({ stage: "reading", learn: true }, base, { phase: "reading", read: 10, target: 60, proposals: [] })).toMatchObject({ title: "Reading how you work", line: "10 of 60 chats" });
    expect(railCard({ stage: "rules", learn: true }, base, { phase: "done", read: 60, target: 60, proposals: [1, 2] })).toMatchObject({ title: "2 suggested rules are ready", open: "rules" });
  });

  it("a card for work in progress opens nothing", () => {
    expect(railCard({ stage: "importing", learn: false }, base, idle)!.open).toBeUndefined();
  });
});
