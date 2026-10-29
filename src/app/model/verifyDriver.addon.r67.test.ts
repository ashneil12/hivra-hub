// @vitest-environment happy-dom
// r67 #11 (frank's A2): the bench's DOM rows say whether an add-on offer is ticked, so a fresh dev install's first
// project can show Critiquito offered but unticked as evidence, without anyone driving the screen.
import { afterEach, expect, it } from "vitest";
import { domRows } from "./verifyDriver";

afterEach(() => {
  document.body.innerHTML = "";
});

it("reports aria-checked on the add-on offer", () => {
  document.body.innerHTML = `<main><label data-hub-addon><button type="button" role="checkbox" aria-checked="false" data-hub-onboarding-addon></button>Also add Critiquito: design review</label></main>`;
  const rows = domRows() as unknown as { elements: { attrs: Record<string, string> }[] };
  const offer = rows.elements.find((e) => "data-hub-onboarding-addon" in e.attrs);
  expect(offer?.attrs["aria-checked"]).toBe("false");
  expect(offer?.attrs.role).toBe("checkbox");
});
