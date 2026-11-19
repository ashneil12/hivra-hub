// @vitest-environment happy-dom
// A fresh dev copy has no team (WP-05). The bench's pre-load has to add the starter Monos, seat them in the
// project's leadership room, and do nothing the second time. A real launch still adds nobody.
import { beforeEach, expect, it } from "vitest";
import { benchAshTeam } from "./benchAshTeam";
import { getChat, resetRoomsForTests } from "../../features/hub/model/hubChats";
import { addMono, findMono, listMonos } from "../../features/monos/model/mono";
import { starterOffers } from "../../features/hub/model/starterMonos";
import { ensureBuiltInMonos } from "../../features/hub/model/builtInMonos";

beforeEach(() => {
  localStorage.clear();
  resetRoomsForTests();
});

it("adds every starter, seats them, and adds nothing the second time", async () => {
  expect(ensureBuiltInMonos()).toBe(0);
  expect(listMonos()).toEqual([]);

  const offers = starterOffers();
  expect(offers.length).toBeGreaterThan(0);
  const first = await benchAshTeam({ project: "tally" });
  const monos = first.monos;

  expect(monos.map((mono) => mono.name).sort()).toEqual(offers.map((offer) => offer.name).sort());
  expect(new Set(monos.map((mono) => mono.id)).size).toBe(offers.length);
  for (const mono of monos) {
    expect(offers.some((offer) => offer.id === mono.id)).toBe(false);
    const saved = findMono(mono.id);
    const offer = offers.find((item) => item.name === mono.name);
    expect(saved?.instructions).toBe(offer?.soul);
    expect(saved?.name).toBe(offer?.name);
  }

  const room = getChat("tally:leadership");
  expect(room?.memberIds.slice().sort()).toEqual(monos.map((mono) => mono.id).sort());

  const ids = listMonos().map((mono) => mono.id);
  const second = await benchAshTeam({ project: "tally" });
  expect(listMonos().map((mono) => mono.id)).toEqual(ids);
  expect(getChat("tally:leadership")?.memberIds.slice().sort()).toEqual(room?.memberIds.slice().sort());
  expect(second.monos.map((mono) => mono.id).sort()).toEqual(monos.map((mono) => mono.id).sort());
});

it("keeps a Mono already named like a starter, and still seats it", async () => {
  const offer = starterOffers().find((item) => item.name === "Chief of Staff");
  expect(offer).toBeDefined();
  addMono({ id: "kept-coord", name: "Chief of Staff", mascot: "robot", color: "hsl(210 8% 58%)", projects: [], instructions: "mine, rewritten" });

  const seated = await benchAshTeam({ project: "tally" });
  expect(listMonos().filter((mono) => mono.name === "Chief of Staff")).toHaveLength(1);
  expect(findMono("kept-coord")?.instructions).toBe("mine, rewritten");
  expect(seated.monos.find((mono) => mono.name === "Chief of Staff")?.id).toBe("kept-coord");
  expect(getChat("tally:leadership")?.memberIds).toContain("kept-coord");
  expect(listMonos()).toHaveLength(starterOffers().length);
});

it("says which starter each Mono is, so a bench never has to guess by name", async () => {
  const seated = await benchAshTeam({ project: "tally" });
  const offers = starterOffers();
  for (const mono of seated.monos) {
    const offer = offers.find((item) => item.name === mono.name);
    expect(mono.specId).toBe(offer?.id);
  }
  expect(new Set(seated.monos.map((mono) => mono.specId)).size).toBe(offers.length);
});

it("ties every starter to the project it is seated in", async () => {
  const seated = await benchAshTeam({ project: "/work/tally" });
  for (const mono of seated.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/tally"]);
  // A second call adds nothing and ties nothing twice.
  const again = await benchAshTeam({ project: "/work/tally" });
  for (const mono of again.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/tally"]);
});

it("adds the project to a Mono already on the roster, once, and leaves its other projects alone", async () => {
  // Before the bench runs, so this is the Mono it finds by name rather than a second Planner.
  addMono({ id: "kept-planner", name: "Planner", mascot: "robot", color: "hsl(210 8% 58%)", projects: ["/work/other"], instructions: "mine" });
  const tied = await benchAshTeam({ project: "/work/tally" });
  expect(tied.monos.find((mono) => mono.name === "Planner")?.id).toBe("kept-planner");
  expect(findMono("kept-planner")?.projects).toEqual(["/work/other", "/work/tally"]);
  expect(findMono("kept-planner")?.instructions).toBe("mine");
  await benchAshTeam({ project: "/work/tally" });
  expect(findMono("kept-planner")?.projects).toEqual(["/work/other", "/work/tally"], "tied once, never twice");
});

it("ties nobody to a project when none is named", async () => {
  const none = await benchAshTeam({});
  expect(none.monos.length).toBe(starterOffers().length);
  for (const mono of none.monos) expect(findMono(mono.id)?.projects).toEqual([]);
  expect(getChat("tally:leadership")).toBeUndefined();
});

it("seats the room under a project's id and ties each Mono to the project's folder", async () => {
  // A hub project's id ("verify") is never its folder (/work/chartwell): the room belongs to the first, and the Monos
  // have to work on the second, or a kickoff aimed at the folder never finds them (verifyKickoff.verifyKickoffMono).
  const seated = await benchAshTeam({ project: "verify", folder: "/work/chartwell" });
  for (const mono of seated.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/chartwell"]);
  expect(getChat("verify:leadership")?.memberIds.slice().sort()).toEqual(seated.monos.map((mono) => mono.id).sort());
  expect(getChat("/work/chartwell:leadership")).toBeUndefined();
});

it("ties the folder once, and never the id as well", async () => {
  await benchAshTeam({ project: "verify", folder: "/work/chartwell" });
  const again = await benchAshTeam({ project: "verify", folder: "/work/chartwell" });
  for (const mono of again.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/chartwell"]);
});

it("ties a named folder even when no project id is given, and seats nobody", async () => {
  const tied = await benchAshTeam({ folder: "/work/chartwell" });
  for (const mono of tied.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/chartwell"]);
  expect(getChat("/work/chartwell:leadership")).toBeUndefined();
});

it("treats a blank folder as no folder at all", async () => {
  // A folder only some of the way through a value is not one: it falls back to the id, as before.
  const seated = await benchAshTeam({ project: "/work/tally", folder: "   " });
  for (const mono of seated.monos) expect(findMono(mono.id)?.projects).toEqual(["/work/tally"]);
  expect(getChat("/work/tally:leadership")?.memberIds.length).toBe(starterOffers().length);
});
