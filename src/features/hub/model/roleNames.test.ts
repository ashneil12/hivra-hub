// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { plainName, roleNamesOn, roleNamesUndecided, setRoleNames } from "./roleNames";

beforeEach(() => localStorage.clear());

it("plain role names come first, with the Mono's own name after", () => {
  expect(roleNamesUndecided()).toBe(true);
  expect(plainName("frank")).toEqual({ primary: "Memory and checks", secondary: "frank" });
  expect(plainName("Alfred")).toEqual({ primary: "Team setup", secondary: "Alfred" });
  expect(plainName("Critiquito")).toEqual({ primary: "Design review", secondary: "Critiquito" });
  expect(plainName("Chief of Staff")).toEqual({ primary: "Chief of Staff" });
});

it("Keep current names turns them off and is remembered", () => {
  setRoleNames(false);
  expect(roleNamesOn()).toBe(false);
  expect(roleNamesUndecided()).toBe(false);
  expect(plainName("frank")).toEqual({ primary: "frank" });
  setRoleNames(true);
  expect(plainName("frank").primary).toBe("Memory and checks");
});
