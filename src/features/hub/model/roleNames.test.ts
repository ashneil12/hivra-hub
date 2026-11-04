// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { plainName, roleNamesOn, roleNamesUndecided, setRoleNames } from "./roleNames";

beforeEach(() => localStorage.clear());

it("a mono shows its own name, and turning role names on does not rewrite it", () => {
  expect(roleNamesUndecided()).toBe(true);
  expect(plainName("ed")).toEqual({ primary: "ed" });
  setRoleNames(true);
  expect(roleNamesOn()).toBe(true);
  expect(plainName("ed")).toEqual({ primary: "ed" });
  expect(plainName("Ada")).toEqual({ primary: "Ada" });
  expect(plainName("  ")).toEqual({ primary: "  " });
});

it("Keep current names turns them off and is remembered", () => {
  setRoleNames(false);
  expect(roleNamesOn()).toBe(false);
  expect(roleNamesUndecided()).toBe(false);
  expect(plainName("ed")).toEqual({ primary: "ed" });
  setRoleNames(true);
  expect(plainName("ed").primary).toBe("ed");
});
