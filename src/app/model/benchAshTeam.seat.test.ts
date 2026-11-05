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
  const offer = starterOffers().find((item) => item.name === "Coordinator");
  expect(offer).toBeDefined();
  addMono({ id: "kept-coord", name: "Coordinator", mascot: "robot", color: "hsl(210 8% 58%)", projects: [], instructions: "mine, rewritten" });

  const seated = await benchAshTeam({ project: "tally" });
  expect(listMonos().filter((mono) => mono.name === "Coordinator")).toHaveLength(1);
  expect(findMono("kept-coord")?.instructions).toBe("mine, rewritten");
  expect(seated.monos.find((mono) => mono.name === "Coordinator")?.id).toBe("kept-coord");
  expect(getChat("tally:leadership")?.memberIds).toContain("kept-coord");
  expect(listMonos()).toHaveLength(starterOffers().length);
});
