// @vitest-environment happy-dom
// G4: which chat is pinned on top in a project (the Chief of Staff's or the Lead's) is kept per project in the local hub
// store, so a relaunch opens the same one.
import { afterEach, beforeEach, expect, it } from "vitest";
import { memoryDisk, type LocalHubDisk } from "./localHub/localHub";
import {
  PROJECT_PREFS_DOC,
  loadProjectFronts,
  projectFront,
  projectFrontsSaved,
  resetProjectFronts,
  setProjectFront,
  setProjectFrontDisk,
} from "./projectFront";

beforeEach(() => resetProjectFronts());
afterEach(() => {
  resetProjectFronts();
  setProjectFrontDisk(undefined);
});

/** A relaunch: this run's memory goes and the store is read again. */
async function relaunch(): Promise<void> {
  resetProjectFronts();
  await loadProjectFronts();
}

it("a relaunch keeps the chat pinned on top, per project", async () => {
  const disk = memoryDisk();
  setProjectFrontDisk(disk);
  await loadProjectFronts();
  expect(projectFront("alpha")).toBe("captain");
  setProjectFront("alpha", "lead");
  await projectFrontsSaved();
  await relaunch();
  expect(projectFront("alpha")).toBe("lead");
  expect(projectFront("beta")).toBe("captain");
  setProjectFront("alpha", "captain");
  await projectFrontsSaved();
  await relaunch();
  expect(projectFront("alpha")).toBe("captain");
});

it("writes on top of another window's change, never over it, and keeps what else the document holds", async () => {
  const disk = memoryDisk({ [PROJECT_PREFS_DOC]: { fronts: { beta: "lead" }, other: 1 } });
  let raced = false;
  // Another window writes between this window's read and its write.
  const racing: LocalHubDisk = {
    ...disk,
    async write(key, value, rev) {
      if (!raced && key === PROJECT_PREFS_DOC) {
        raced = true;
        await disk.write(key, { fronts: { beta: "lead", gamma: "lead" }, other: 1 }, rev);
      }
      return disk.write(key, value, rev);
    },
  };
  setProjectFrontDisk(racing);
  await loadProjectFronts();
  setProjectFront("alpha", "lead");
  await projectFrontsSaved();
  expect(raced).toBe(true);
  expect(disk.docs.get(PROJECT_PREFS_DOC)).toEqual({ fronts: { beta: "lead", gamma: "lead", alpha: "lead" }, other: 1 });
});

it("hears another window's change, and a choice made before the store answered is not lost", async () => {
  const disk = memoryDisk({ [PROJECT_PREFS_DOC]: { fronts: { beta: "lead" } } });
  setProjectFrontDisk(disk);
  setProjectFront("alpha", "lead");
  await loadProjectFronts();
  expect(projectFront("alpha")).toBe("lead");
  expect(projectFront("beta")).toBe("lead");
  await projectFrontsSaved();
  await disk.write(PROJECT_PREFS_DOC, { fronts: { alpha: "lead" } }, (await disk.readDoc(PROJECT_PREFS_DOC)).rev);
  await loadProjectFronts();
  expect(projectFront("beta")).toBe("captain");
});

it("a store that cannot be read keeps this run's choice and the default", async () => {
  const broken: LocalHubDisk = {
    read: async () => {
      throw new Error("down");
    },
    readDoc: async () => {
      throw new Error("down");
    },
    write: async () => {
      throw new Error("down");
    },
  };
  setProjectFrontDisk(broken);
  await loadProjectFronts();
  expect(projectFront("alpha")).toBe("captain");
  setProjectFront("alpha", "lead");
  await projectFrontsSaved();
  expect(projectFront("alpha")).toBe("lead");
});
