// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import {
  findBotChange,
  recordSelfWrite,
  setBotFiles,
  undoBotChange,
  type BotFiles,
} from "./botChanges";

const SOUL = "SOUL.md" as AgentFilePath;

/** A Mono's folder as a map, with a hash that follows the text. */
function filesInMemory(initial: Record<string, string>) {
  const texts = new Map(Object.entries(initial));
  const hash = (path: string) => `h:${texts.get(path) ?? ""}`;
  const files: BotFiles = {
    read: async (_monoId, path) => ({
      text: texts.get(path) ?? null,
      hash: hash(path),
    }),
    write: async (_monoId, path, text, expected) => {
      if (expected !== hash(path)) throw new Error("conflict");
      texts.set(path, text);
      return hash(path);
    },
  };
  return { files, texts };
}

function selfWrite(run: string, before: string, after: string) {
  return {
    monoId: "mono-1",
    bot: "Hivra lead",
    file: SOUL,
    line: "Hivra lead changed its soul",
    before,
    after,
    run,
  };
}

it("records a Mono's own write as one row holding the file before and after (D1)", () => {
  recordSelfWrite(selfWrite("run-a", "old soul\n", "new soul\n"));
  const row = findBotChange("self-write:mono-1:SOUL.md:run-a");
  expect(row).toMatchObject({
    bot: "Hivra lead",
    line: "Hivra lead changed its soul",
    monoId: "mono-1",
    file: "SOUL.md",
    beforeText: "old soul\n",
    afterText: "new soul\n",
    undoneText: "Undone: Hivra lead's file is back to how it was before it changed it.",
  });
  // Plain words only: the row is never bundled with the "tidied N skills" small changes, and never prints the file.
  expect(row?.small).toBeUndefined();
  expect(`${row!.now}${row!.after}`).not.toMatch(/soul\b|SOUL\.md/);
});

it("folds a second write from the same run into the row, keeping the file as that run found it", () => {
  recordSelfWrite(selfWrite("run-b", "one\n", "two\n"));
  recordSelfWrite(selfWrite("run-b", "two\n", "three\n"));
  expect(findBotChange("self-write:mono-1:SOUL.md:run-b")).toMatchObject({
    beforeText: "one\n",
    afterText: "three\n",
  });
});

it("gives another run its own row", () => {
  recordSelfWrite(selfWrite("run-c", "one\n", "two\n"));
  recordSelfWrite(selfWrite("run-d", "two\n", "three\n"));
  expect(findBotChange("self-write:mono-1:SOUL.md:run-c")).toMatchObject({
    beforeText: "one\n",
    afterText: "two\n",
  });
  expect(findBotChange("self-write:mono-1:SOUL.md:run-d")).toMatchObject({
    beforeText: "two\n",
    afterText: "three\n",
  });
});

it("records nothing when the write left the file as it was", () => {
  recordSelfWrite(selfWrite("run-e", "same\n", "same\n"));
  expect(findBotChange("self-write:mono-1:SOUL.md:run-e")).toBeUndefined();
});

it("Undo really puts the file back, and the run's next write starts a new row", async () => {
  const { files, texts } = filesInMemory({ "SOUL.md": "two\n" });
  setBotFiles(files);
  recordSelfWrite(selfWrite("run-f", "one\n", "two\n"));
  const id = "self-write:mono-1:SOUL.md:run-f";

  await undoBotChange([id]);
  expect(texts.get("SOUL.md")).toBe("one\n");
  expect(findBotChange(id)?.undone).toBe(true);

  // The undone row must not swallow the next write: it starts afresh from the file Undo restored.
  recordSelfWrite(selfWrite("run-f", "one\n", "three\n"));
  expect(findBotChange(id)).toMatchObject({
    beforeText: "one\n",
    afterText: "three\n",
  });
  expect(findBotChange(id)?.undone).toBeUndefined();
});
