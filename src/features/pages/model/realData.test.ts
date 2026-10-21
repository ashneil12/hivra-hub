// Ash, 21 Oct: a page pulls the project's real data, or says "Nothing here yet"; no made-up sample numbers in the app.
import { expect, it } from "vitest";
import { checkBuiltSpec, hasMadeUpData, REAL_DATA_ONLY } from "./buildPage";

const spec = (blocks: unknown[]) => ({ kind: "blocks", title: "Hivra this week", blocks });

it("a Mono's page_build turns down example data; an empty block is fine; other paths relay what they get", () => {
  const example = spec([{ kind: "list", title: "Bugs", rows: [{ text: "Example: shader step fails", state: "bad", label: "Open" }] }]);
  expect(hasMadeUpData(example)).toBe(true);
  expect(checkBuiltSpec(example, { real: true })).toEqual({ status: "turned-down", reason: REAL_DATA_ONLY });
  expect(checkBuiltSpec(example).status).toBe("ready");
  const empty = spec([{ kind: "chart", title: "Sign-ups per day", bars: [] }, { kind: "list", title: "Open bugs", rows: [] }]);
  expect(checkBuiltSpec(empty, { real: true }).status).toBe("ready");
  const real = spec([{ kind: "barlist", title: "Shipped per day", rows: [{ label: "Mon", value: 2 }] }]);
  expect(checkBuiltSpec(real, { real: true }).status).toBe("ready");
});

it("page_build from chat says why it turned made-up data down", async () => {
  const { previewFromChat } = await import("../../selfBuild/model/pagesChat");
  const spec = { kind: "blocks", title: "Hivra", blocks: [{ kind: "status", title: "This week", state: "ok", line: "Example: 212 sign-ups", detail: "" }] };
  expect(() => previewFromChat({ spec, request: "a page" }, { monoId: "hivra-lead", name: "Hivra lead" })).toThrow(/real data/);
});
