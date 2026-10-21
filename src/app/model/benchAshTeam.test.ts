// @vitest-environment happy-dom
// The realconv bench's teamPack {pack:"ash"} op runs benchAshTeam (the app's pre-load until PM round 19) on a fresh dev copy (G5: it starts plain).
// After it, every prompt surface must be byte for byte what 4b7bb1b built for Ash (testdata/ashPrompts.4b7bb1b.json),
// so bench runs judge Ash's real prompts, not the "the user" rewrite (PM G5 round 18, 6cb79d13).
import BEFORE_JSON from "../../features/hub/model/testdata/ashPrompts.4b7bb1b.json";
import { beforeEach, expect, it } from "vitest";
import { benchAshTeam } from "./benchAshTeam";
import { promptSurfaces } from "../../features/hub/model/promptSurfaces.testkit";
import { teamPack } from "../../features/hub/model/teamPack";
import { userName } from "../../features/hub/model/userName";

const BEFORE: Record<string, string> = BEFORE_JSON;

beforeEach(() => {
  localStorage.clear();
});

it("a fresh plain dev copy, after the bench's Ash pre-load, builds every prompt byte for byte as 4b7bb1b", async () => {
  expect(teamPack()).toBe("plain"); // what a fresh temp-HOME dev copy records at first render
  expect(userName()).toBeUndefined();
  const files = new Map<string, string>();
  await benchAshTeam(
    async (id, name) => ({ text: files.get(`${id}/${name}`) ?? null }) as never,
    async (id, name, text) => {
      files.set(`${id}/${name}`, text);
    },
  );
  expect(userName()).toBe("Ash");
  const now = promptSurfaces();
  expect(Object.keys(now).sort()).toEqual(Object.keys(BEFORE).sort());
  for (const [k, text] of Object.entries(BEFORE)) expect(now[k], k).toBe(text);
});
