import { expect, test } from "vitest";
import { markdownText, parseMarkdown } from "./markdown";

test("plain text, emphasis and a safe link come back as nodes", () => {
  const nodes = parseMarkdown("See **this** and [docs](https://example.com/a).");
  expect(nodes[0]?.type).toBe("paragraph");
  expect(markdownText(nodes)).toBe("See this and docs.");
  const link = nodes[0] && "children" in nodes[0] ? nodes[0].children.find((child) => child.type === "link") : undefined;
  expect(link && link.type === "link" ? link.href : "").toBe("https://example.com/a");
});

test("a script and a javascript link stay text", () => {
  const script = parseMarkdown("<script>alert(1)</script>");
  expect(markdownText(script)).toBe("<script>alert(1)</script>");
  expect(JSON.stringify(script)).not.toContain("\"href\"");
  const bad = parseMarkdown("[click](javascript:alert(1))");
  expect(markdownText(bad)).toBe("click");
  expect(JSON.stringify(bad)).not.toContain("javascript:");
});

test("empty, a list, and windows line endings", () => {
  expect(parseMarkdown("")).toEqual([]);
  expect(parseMarkdown("   ")).toEqual([]);
  const list = parseMarkdown("- one\r\n- two");
  expect(list.map((node) => node.type)).toEqual(["item", "item"]);
  expect(markdownText(list)).toBe("onetwo");
});
