// r76 (blind s13): the Lead echoed a 40-ask dump, one item reading 'what "done" means', and the ask checker took that as
// a done claim, then sent two [MonoCode check] turns that had the Lead re-fix ask 1 instead of starting workers.
import { expect, it } from "vitest";
import { doneClaimOf } from "./askLedger";

it("a quoted word is not a done claim", () => {
  expect(doneClaimOf('A goal needs a target field, progress, and what "done" means before it earns a place.')).toBeUndefined();
  expect(doneClaimOf("Item 9 is the “fixed” label in the header.")).toBeUndefined();
  expect(doneClaimOf("Rename the `done` column to `closed`.")).toBeUndefined();
});

it("a real claim still counts", () => {
  expect(doneClaimOf("Fixed: the +1 button is a 48px target under 640px.")).toBe("Fixed: the +1 button is a 48px target under 640px.");
  expect(doneClaimOf('Done, the title says "Team board" now.')).toBe('Done, the title says "Team board" now.');
});
