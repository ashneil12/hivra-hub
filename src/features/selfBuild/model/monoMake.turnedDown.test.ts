// @vitest-environment happy-dom
// r48 (Alfred's blind A1 rerun, 22 Oct): a Mono card Ash turned down ("Not this one") is never made later, and the
// drafting Mono is told what really happened to each of its cards, so it never says "the card at the top" of one that
// is gone, or takes a fresh ask in a new conversation as already done.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const ME = { monoId: "chief-of-staff", name: "Chief of Staff", projects: ["/Users/ash/Projects/monocode-hub"] };
const POSTIE = {
  name: "Postie",
  role: "Drafts X posts",
  who: "I'm Postie. I draft your X posts, casual.",
  watchFor: "Posting or scheduling on its own.",
};

it("a turned-down card can't be made, and its Mono hears it was turned down, with the time", async () => {
  const make = await import("./monoMake");
  const at = new Date(2026, 9, 22, 14, 13).getTime();
  const draft = make.draftMono(POSTIE, ME, at, undefined, { room: "hub:leadership", conv: "conv-old" });
  expect(make.draftStatusLines("chief-of-staff", { room: "hub:leadership", conv: "conv-old" }, at + 1000)).toEqual([
    `"Postie": waiting on Ash's yes; its card shows in this chat.`,
  ]);
  expect(make.draftStatusLines("chief-of-staff", { room: "hub:leadership", conv: "conv-new" }, at + 1000)[0]).toMatch(
    /in another chat, not this one/,
  );

  make.dismissDraft(draft.draftId, new Date(2026, 9, 22, 14, 16).getTime());
  expect(make.waitingDrafts()).toEqual([]);
  expect(make.draftStatusLines("chief-of-staff", { room: "hub:leadership", conv: "conv-new" }, at + 60 * 60_000)).toEqual([
    `"Postie": turned down by Ash ("Not this one") at 14:16; nothing was made and no card shows.`,
  ]);
  // Another Mono's cards are not this one's news; three days on, nothing is said.
  expect(make.draftStatusLines("projects-manager", undefined, at + 1000)).toEqual([]);
  expect(make.draftStatusLines("chief-of-staff", undefined, at + 4 * 24 * 60 * 60_000)).toEqual([]);

  const host = { ashSpokeSince: () => true, room: () => ({ id: "r", name: "r" }) };
  await expect(make.makeDrafted(draft.draftId, ME, host)).rejects.toThrow(/turned this card down/);
});

// r50 (A1: CoS told Ash "the X posts Mono is the card at the top" when no card existed): the draft's own note says the
// card lasts only until Ash answers it, so a Mono never points to it after that.
it("the draft note says the card is gone once Ash turns it down or it is made", async () => {
  const make = await import("./monoMake");
  const draft = make.draftMono(POSTIE, ME, Date.now(), undefined, { room: "hub:leadership", conv: "c" });
  expect(draft.note).toMatch(/only until (he|the user) answers it/);
  expect(draft.note).toMatch(/never point (him|them) to it after that/);
  // r62 (A5): CoS said "click that one" on a card whose only button is "Not this one".
  expect(draft.note).toMatch(/no yes button/);
  expect(draft.note).toMatch(/never tell (him|them) to click/);
});
