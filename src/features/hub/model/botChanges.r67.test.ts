// @vitest-environment happy-dom
// r67 (Alfred's r66 rechecks): Settings > Changes > Bot changes showed "Postie changed its soul" while Postie was
// retired. A retired Mono's own file changes stay out of the list; the rows that retired it, or made it, stay.
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import type { Mono } from "../../monos/model/mono";
import type { BotChange } from "./botChanges";

const SOUL = "SOUL.md" as AgentFilePath;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const soulEdit = (monoId: string, bot: string): BotChange =>
  ({ id: `e-${monoId}`, bot, day: "Today", line: `${bot} changed its soul`, now: "a", after: "b", monoId, file: SOUL, beforeText: "a", afterText: "b" }) as BotChange;

it("retired Monos: a standing retirement, an undone 'made a new Mono', or gone from the roster; a brought-back one is not", async () => {
  const { retiredMonoIds } = await import("./botChanges");
  const postie = { id: "postie", name: "Postie" } as Mono;
  const changes: BotChange[] = [
    soulEdit("postie", "Postie"),
    { id: "m1", bot: "Chief of Staff", day: "Today", line: "Chief of Staff made a new Mono, Postie", now: "", after: "", made: { monoId: "postie" }, undone: true } as BotChange,
    { id: "r1", bot: "Chief of Staff", day: "Today", line: "Chief of Staff retired Scout", now: "", after: "", retired: { mono: { id: "scout" } as Mono, index: 0, archive: "x", at: "" } } as BotChange,
    { id: "r2", bot: "Chief of Staff", day: "Today", line: "Chief of Staff retired Echo", now: "", after: "", retired: { mono: { id: "echo" } as Mono, index: 0, archive: "x", at: "" }, undone: true } as BotChange,
    soulEdit("ghost", "Ghost"),
    soulEdit("frank", "frank"),
  ];
  const ids = retiredMonoIds(changes, ["frank", "echo"]);
  expect([...ids].sort()).toEqual(["ghost", "postie", "scout"]);
  void postie;
});

it("the list hides a retired Mono's soul change and keeps everyone else's", async () => {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const bc = await import("./botChanges");
  bc.recordBotChange({ id: "postie-soul", bot: "Postie", day: "Today", line: "Postie changed its soul", now: "a", after: "b", monoId: "postie", file: SOUL, beforeText: "a", afterText: "b" });
  bc.recordBotChange({ id: "frank-soul", bot: "frank", day: "Today", line: "frank changed its soul", now: "a", after: "b", monoId: "frank", file: SOUL, beforeText: "a", afterText: "b" });
  const lines = bc.botChangeRows().flatMap((r) => (r.kind === "one" ? [r.change.line] : []));
  expect(lines).toContain("frank changed its soul");
  expect(lines).not.toContain("Postie changed its soul");
});
