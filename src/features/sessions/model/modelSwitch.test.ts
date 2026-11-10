import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { withModelSwitchMarker, type SwitchSession } from "./modelSwitch";

const user = (id: string, text: string, extra: Partial<Block> = {}): Block =>
  ({ id, role: "user", text, ...extra }) as Block;

const chat = (extra: Partial<SwitchSession> = {}): SwitchSession => ({
  harness: "opencode",
  model: "opencode:glm-5",
  blocks: [user("u", "hello")],
  ...extra,
});

const labels = (id: string) => (id === "opencode:glm-5" ? "GLM 5" : id === "pi:default" ? "Pi" : id);

describe("withModelSwitchMarker", () => {
  it("adds a system line when the model changes and the CLI stays", () => {
    const before = chat();
    const after = chat({ model: "pi:default" });
    const next = withModelSwitchMarker(before, after, labels);
    expect(next.blocks.at(-1)).toMatchObject({
      id: "model-switch-1-pi:default",
      role: "system",
      text: "Switched model from GLM 5 to Pi.",
    });
    expect(next.model).toBe("pi:default");
  });

  it("does not mark a CLI change, the same model, or a chat with no sent prompt", () => {
    const before = chat();
    expect(withModelSwitchMarker(before, chat({ harness: "pi", model: "pi:default" }), labels).blocks).toHaveLength(1);
    expect(withModelSwitchMarker(before, chat(), labels).blocks).toHaveLength(1);
    expect(
      withModelSwitchMarker(chat({ blocks: [] }), chat({ blocks: [], model: "pi:default" }), labels).blocks,
    ).toEqual([]);
    expect(
      withModelSwitchMarker(
        chat({ blocks: [user("d", "draft", { draft: true })] }),
        chat({ blocks: [user("d", "draft", { draft: true })], model: "pi:default" }),
        labels,
      ).blocks,
    ).toHaveLength(1);
    expect(
      withModelSwitchMarker(
        chat({ blocks: [user("i", "secret", { internal: true })] }),
        chat({ blocks: [user("i", "secret", { internal: true })], model: "pi:default" }),
        labels,
      ).blocks,
    ).toHaveLength(1);
    const note = user("n", "[MonoCode check] From the app: look again");
    expect(
      withModelSwitchMarker(chat({ blocks: [note] }), chat({ blocks: [note], model: "pi:default" }), labels).blocks,
    ).toHaveLength(1);
  });

  it("does not repeat the same line, and suffixes an id that is already taken", () => {
    const before = chat();
    const after = chat({ model: "pi:default" });
    const once = withModelSwitchMarker(before, after, labels);
    const twice = withModelSwitchMarker({ ...once, model: "opencode:glm-5" }, once, labels);
    expect(twice.blocks.filter((block) => block.role === "system")).toHaveLength(1);

    const taken = chat({
      blocks: [user("u", "hello"), { id: "model-switch-2-pi:default", role: "system", text: "older" } as Block],
    });
    const next = withModelSwitchMarker(taken, { ...taken, model: "pi:default" }, labels);
    expect(next.blocks.at(-1)?.id).toBe("model-switch-2-pi:default-again");
  });

  it("uses the id when no label is known", () => {
    const next = withModelSwitchMarker(chat({ model: "old-model" }), chat({ model: "new-model" }), (id) => id);
    expect(next.blocks.at(-1)?.text).toBe("Switched model from old-model to new-model.");
  });
});
