import { expect, test } from "vitest";
import { runBulk } from "./bulk";

test("an empty selection does nothing", async () => {
  expect(await runBulk([], async () => "ok", () => true)).toBe("ok");
});

test("a stale write stops the rest, and a missing task is skipped", async () => {
  const seen: string[] = [];
  const result = await runBulk(["a", "gone", "b", "c"], async (id) => {
    seen.push(id);
    if (id === "gone") return "missing";
    if (id === "b") return "stale";
    return "ok";
  }, () => true);
  expect(result).toBe("stale");
  expect(seen).toEqual(["a", "gone", "b"]);
});

test("a newer bulk stops this one, and a thrown call is not a final failure", async () => {
  let current = true;
  const stopped = await runBulk(["a", "b"], async (id) => {
    if (id === "a") current = false;
    return "ok";
  }, () => current);
  expect(stopped).toBe("later");
  const thrown = await runBulk(["a"], async () => {
    throw new Error("offline");
  }, () => true);
  expect(thrown).toBe("unreachable");
});
