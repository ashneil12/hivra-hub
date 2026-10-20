// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { importCustomModels, listCustomModels } from "./customModels";

beforeEach(() => localStorage.clear());

const model = (id: string, baseUrl: unknown) => ({
  id,
  name: `Model ${id}`,
  provider: "custom",
  baseUrl,
  modelId: "some-model",
});

it("imports only models whose address passes the same check as the form, and says why the rest were left out", () => {
  const skipped: string[] = [];
  const added = importCustomModels(
    [
      model("ok", "https://example.com/v1"),
      model("local", "http://localhost:11434"),
      model("file", "file:///etc/passwd"),
      model("script", "javascript:alert(1)"),
      model("none", undefined),
      model("number", 42),
      model("anthropic", "https://api.anthropic.com/v1"),
    ],
    (reason) => skipped.push(reason),
  );
  expect(added).toBe(2);
  expect(listCustomModels().map((m) => m.id)).toEqual(["ok", "local"]);
  expect(skipped).toHaveLength(5);
  expect(skipped[0]).toContain("Model file");
  expect(skipped[0]).toContain("https://");
  expect(skipped.at(-1)).toContain("Anthropic");
});

it("still drops a bad address with no one listening for reasons", () => {
  expect(importCustomModels([model("file", "file:///etc/passwd")])).toBe(0);
  expect(listCustomModels()).toEqual([]);
});
