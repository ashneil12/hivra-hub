import { expect, it } from "vitest";
import { letterOf } from "./ProjectMenu";

const p = (id: string, name: string) => ({ id, name, shortName: name });
const all = [p("exo", "EXO"), p("hivra", "Hivra"), p("nibbii", "Nibbii"), p("ash", "Harness")];

it("uses two letters only when another project shares the first", () => {
  expect(all.map((x) => letterOf(x, all))).toEqual(["E", "Hi", "N", "Ha"]);
  expect(letterOf(p("hivra", "Hivra"), [p("hivra", "Hivra"), p("exo", "EXO")])).toBe("H");
  expect(letterOf(p("hivra", "Hivra"))).toBe("H");
  expect(letterOf(p("x", "X"), [p("x", "X"), p("y", "xylo")])).toBe("X");
});
