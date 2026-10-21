// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { addMono, findMono, monoAvatar, monoLook, saveMonoMascot, saveMonoTileLetters } from "./mono";

beforeEach(() => localStorage.clear());

it("a Mono shows its letter unless a mascot was picked on purpose", () => {
  expect(monoAvatar({ mascot: "robot", name: "Hivra lead" })).toBe("letter:HI");
  expect(monoAvatar({ mascot: "ghost" })).toBe("letter:MO");
  expect(monoAvatar({ mascot: "cat", mascotPicked: true, name: "x" })).toBe("cat");
});

it("picking a mascot keeps it; picking Letter goes back", () => {
  addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "rocket", color: "gray", projects: [] });
  expect(monoLook(findMono("hivra-lead")!).mascot).toBe("letter:HI");
  saveMonoMascot("hivra-lead", "cat");
  expect(findMono("hivra-lead")?.mascotPicked).toBe(true);
  expect(monoLook(findMono("hivra-lead")!).mascot).toBe("cat");
  saveMonoMascot("hivra-lead", "letter");
  expect(findMono("hivra-lead")?.mascotPicked).toBeUndefined();
  expect(monoLook(findMono("hivra-lead")!).mascot).toBe("letter:HI");
});

it("Hivra lead and Harness lead no longer share a tile", async () => {
  const { monoTileLetters } = await import("./mono");
  const names = ["Chief of Staff", "Projects Manager", "frank", "Alfred", "EXO lead", "Hivra lead", "Nibbii lead", "Harness lead"];
  const tiles = names.map(monoTileLetters);
  expect(tiles).toEqual(["CS", "PM", "FR", "AL", "EX", "HI", "NI", "HA"]);
  expect(new Set(tiles).size).toBe(names.length);
});

it("a tile shows the letters Ash chose, as typed; clearing them goes back to the automatic two capitals", () => {
  addMono({ id: "alfred", name: "Alfred", mascot: "rocket", color: "gray", projects: [] });
  expect(monoLook(findMono("alfred")!).mascot).toBe("letter:AL");
  saveMonoTileLetters("alfred", "Af");
  expect(monoLook(findMono("alfred")!).mascot).toBe("letter:Af");
  saveMonoTileLetters("alfred", "Q");
  expect(monoLook(findMono("alfred")!).mascot).toBe("letter:Q");
  saveMonoTileLetters("alfred", "");
  expect(monoLook(findMono("alfred")!).mascot).toBe("letter:AL");
});
