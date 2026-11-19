import { afterEach, expect, it } from "vitest";
import { setTurnTagger, turnTags } from "./turnTags";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

it("tags a turn only while a tagger is lent, and never from a tagger that throws", () => {
  const turn = [{ id: "u", role: "user" as const, text: "Example" }];
  expect(turnTags("chat", turn)).toBeUndefined();
  release = setTurnTagger((sessionId) => (sessionId === "chat" ? "exo hivra" : ""));
  expect(turnTags("chat", turn)).toBe("exo hivra");
  expect(turnTags("other", turn)).toBeUndefined();
  expect(turnTags(undefined, turn)).toBeUndefined();
  release();
  release = setTurnTagger(() => {
    throw new Error("Example: broken");
  });
  expect(turnTags("chat", turn)).toBeUndefined();
});
