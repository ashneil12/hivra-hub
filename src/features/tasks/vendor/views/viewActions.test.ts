import { expect, test } from "vitest";
import { canDeleteView, deleteViewPrompt, viewPath } from "./viewActions";

test("a view path keeps spaces and unicode inside one segment", () => {
  expect(viewPath("all tasks")).toBe("/views/all%20tasks");
  expect(viewPath("café")).toBe(`/views/${encodeURIComponent("café")}`);
  expect(viewPath("a/b")).toBe("/views/a%2Fb");
  expect(viewPath("")).toBe("/views/");
});

test("the builtin view cannot be deleted, and a missing flag can", () => {
  expect(canDeleteView({ builtin: true })).toBe(false);
  expect(canDeleteView({ builtin: false })).toBe(true);
  expect(canDeleteView({})).toBe(true);
});

test("an empty or blank name still gets a delete sentence", () => {
  expect(deleteViewPrompt({ name: "" })).toBe("This view will be deleted.");
  expect(deleteViewPrompt({ name: "   " })).toBe("This view will be deleted.");
  expect(deleteViewPrompt({ name: "Board" })).toBe("Board will be deleted.");
  expect(deleteViewPrompt({ name: "  Café  " })).toBe("Café will be deleted.");
});
