import { expect, it } from "vitest";
import { phaseDocLinks, phaseLinks } from "./pr";

it("links the research and design documents, and adds nothing for a straight build", () => {
  expect(phaseLinks([])).toBe("");
  const linked = phaseLinks([
    { number: 2, phase: "research", title: "Research", fileName: "02-research.md" },
    { number: 3, phase: "design", title: "Design", fileName: "03-design.md" },
    { number: 4, phase: "outline", title: "Structure outline", fileName: "04-outline.md" },
    { number: 1, phase: "product", title: "Product", fileName: "01-product.md" },
  ]);
  expect(linked).toContain("[Research](02-research.md)");
  expect(linked).toContain("[Design](03-design.md)");
  expect(linked).toContain("[Product](01-product.md)");
  expect(linked).not.toContain("outline");
  expect(linked.indexOf("01-product.md")).toBeLessThan(linked.indexOf("02-research.md"));
  expect(phaseDocLinks([
    { number: 2, phase: "research", title: "Research", fileName: "02-research.md" },
    { number: 4, phase: "outline", title: "Structure outline", fileName: "04-outline.md" },
    { number: 1, phase: "product", title: "Product", fileName: "01-product.md" },
  ])).toEqual([
    { title: "Product", href: "01-product.md" },
    { title: "Research", href: "02-research.md" },
  ]);
});
