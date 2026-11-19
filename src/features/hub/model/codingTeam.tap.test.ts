import { expect, it } from "vitest";
import { projectTapSelection } from "./codingTeam";

// r62 (A6): a tap on Nibbii must switch the project even when the strip opens its Lead's chat.
it("lands a tapped project in its coding team, with or without a folder", () => {
  expect(projectTapSelection({ id: "nibbii", folder: "/Users/ash/Projects/nibbii" })).toEqual({ project: "nibbii", item: "coding-team" });
  expect(projectTapSelection({ id: "nibbii", folder: null })).toEqual({ project: "nibbii", item: "coding-team" });
});
