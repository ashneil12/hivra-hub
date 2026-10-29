// r67 (Critiquito on r66): the Agents page read "Can't read your agents: This page is waiting for you…" before Allow.
// A page still waiting for Allow says what to tap; a real failure still says what went wrong.
import { expect, it } from "vitest";
import { WAITING_ALLOW } from "./bridge";
import { AGENTS_PAGE, BUILT_PAGE, NEEDS_PAGE, PROJECTS_PAGE } from "./readyPages";

const scriptOf = (spec: unknown) => JSON.stringify(spec);
const problemLine = (() => {
  const src = /const problemLine = (\(what, err\) => .*?);\n/.exec((AGENTS_PAGE as unknown as { js: string }).js)?.[1];
  if (!src) throw new Error("problemLine not found in the Agents page");
  return new Function(`return ${src}`)() as (what: string, err: unknown) => string;
})();

it("the Agents line reads 'Tap Allow to show your agents' while the page waits for Allow", () => {
  expect(problemLine("your agents", new Error(WAITING_ALLOW))).toBe("Tap Allow to show your agents");
  expect(problemLine("your agents", new Error("The hub isn't answering"))).toBe("Can't read your agents: The hub isn't answering");
});

it("every ready-made page says it the same way, and none prints the raw waiting line after Can't read", () => {
  for (const spec of [AGENTS_PAGE, NEEDS_PAGE, BUILT_PAGE, PROJECTS_PAGE]) {
    expect(scriptOf(spec)).toContain("problemLine(");
    expect(scriptOf(spec)).not.toMatch(/Can't read [^"]*: " \+ e(?:rr)?\.message/);
  }
});
