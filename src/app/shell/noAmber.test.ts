// r30 (PM): no amber left on the rail or the sidebar. A state is grey, or red when Ash must act (Needs you).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const files = ["Sidebar.tsx", "ProjectRail.tsx", "MonoRailSection.tsx"];

describe("no amber tones on the rail and sidebar", () => {
  for (const name of files) {
    it(`${name} has no amber`, () => {
      const source = readFileSync(resolve(__dirname, name), "utf8");
      expect(source.match(/amber/gi) ?? []).toEqual([]);
    });
  }
});
