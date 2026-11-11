// The chief host effect in App.tsx closes over homeDir. The dependency list has to name it.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the home chief host effect depends on homeDir", () => {
  const src = readFileSync(new URL("../../../app/App.tsx", import.meta.url), "utf8");
  const at = src.indexOf("useEffect(() => setHomeChiefHost(");
  expect(at).toBeGreaterThan(-1);
  const deps = src.slice(at, at + 4000).match(/\}\), \[([^\]]*)\]\)/);
  expect(deps?.[1] ?? "").toMatch(/\bhomeDir\b/);
});
