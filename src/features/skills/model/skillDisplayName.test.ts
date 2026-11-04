import { expect, it } from "vitest";
import { skillDisplayName } from "./skillDisplayName";

it("shows a skill's plain name: its display name, else its id without the owner, hyphens as spaces, capitalised", () => {
  expect(skillDisplayName("ash-copywriting")).toBe("Copywriting");
  expect(skillDisplayName("ash-copywriting", { displayName: "Copy that sells" })).toBe("Copy that sells");
  expect(skillDisplayName("human-writing")).toBe("Human writing");
  expect(skillDisplayName("ada-weekly-review", { owners: ["ada"] })).toBe("Weekly review");
  expect(skillDisplayName("postie:x-drafts")).toBe("X drafts");
  expect(skillDisplayName("Ash-Brand-Voice")).toBe("Brand Voice");
  // An id that is only an owner keeps a name.
  expect(skillDisplayName("ash")).toBe("Ash");
});
