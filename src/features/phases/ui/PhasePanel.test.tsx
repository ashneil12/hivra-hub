import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PhasePanel } from "./PhasePanel";

it("shows the documents in order and the decision at a review", () => {
  const html = renderToStaticMarkup(
    createElement(PhasePanel, {
      pathLabel: "Research, plan, build",
      why: "A wrong choice would be expensive, so research and a design come before building.",
      pathId: "research-plan-build",
      waiting: true,
      onAnswer: () => undefined,
      documents: [
        { number: 2, title: "Research", body: "The save drops the last line." },
        { number: 1, title: "Research questions", body: "Which line does the save drop?" },
      ],
    }),
  );
  expect(html.indexOf("Which line does the save drop?")).toBeLessThan(html.indexOf("The save drops the last line."));
  expect(html).toContain("Looks right");
  expect(html).toContain("Change this");
  expect(html).toContain("Skip to building");
});
