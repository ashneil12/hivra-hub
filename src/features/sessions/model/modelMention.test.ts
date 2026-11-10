import { describe, expect, it } from "vitest";
import {
  firstModelMention,
  insertModelMention,
  judgeModelMention,
  MENTION_NEW_CHAT,
  MENTION_SAME_CLI,
  MENTION_SAME_MODEL,
  MENTION_UNKNOWN_CLI,
  MENTION_UNKNOWN_MODEL,
  modelMentionChoices,
  modelMentionTokenAt,
  recordMentionIntent,
} from "./modelMention";

const KNOWN = {
  model: "opencode:glm-5",
  harness: "opencode",
  knownModels: ["opencode:glm-5", "pi:default", "fx:zai/glm-5.2-fast"],
  knownClis: ["opencode", "pi", "fx", "hermes"],
};

describe("firstModelMention", () => {
  it("reads a model id that contains colons, and strips only trailing punctuation", () => {
    expect(firstModelMention("see @model:opencode:glm-5.")).toMatchObject({
      kind: "model",
      id: "opencode:glm-5",
    });
    expect(firstModelMention("@model:fx:zai/glm-5.2-fast").id).toBe("fx:zai/glm-5.2-fast");
    expect(firstModelMention("@cli:hermes").id).toBe("hermes");
  });

  it("uses the first mention that is not a quote, and leaves an ordinary @ alone", () => {
    expect(firstModelMention("@readme")).toBeNull();
    expect(firstModelMention("@modeling the api")).toBeNull();
    expect(firstModelMention("> @model:pi:default\nthen @cli:pi")).toMatchObject({
      kind: "cli",
      id: "pi",
    });
    expect(firstModelMention("@model:opencode:glm-5 and @cli:pi")?.kind).toBe("model");
  });

  it("keeps a mention after a Windows line break", () => {
    expect(firstModelMention("hello\r\n@cli:fx")?.id).toBe("fx");
  });
});

describe("judgeModelMention", () => {
  it("records a different known model or CLI and says it will start a new chat", () => {
    const model = judgeModelMention("please use @model:pi:default", KNOWN);
    expect(model).toEqual({
      action: "record",
      intent: { kind: "model", id: "pi:default" },
      note: MENTION_NEW_CHAT,
    });
    const cli = judgeModelMention("@cli:hermes", KNOWN);
    expect(cli).toEqual({
      action: "record",
      intent: { kind: "cli", id: "hermes" },
      note: MENTION_NEW_CHAT,
    });
    expect(recordMentionIntent([], (model as { intent: { kind: "model"; id: string } }).intent)).toEqual([
      { kind: "model", id: "pi:default" },
    ]);
  });

  it("ignores an unknown name, the current model, and the current CLI", () => {
    expect(judgeModelMention("@model:nope", KNOWN)).toEqual({
      action: "ignore",
      note: MENTION_UNKNOWN_MODEL,
    });
    expect(judgeModelMention("@model:", KNOWN).action).toBe("ignore");
    expect(judgeModelMention("@cli:missing", KNOWN)).toEqual({
      action: "ignore",
      note: MENTION_UNKNOWN_CLI,
    });
    expect(judgeModelMention("@model:opencode:glm-5", KNOWN)).toEqual({
      action: "ignore",
      note: MENTION_SAME_MODEL,
    });
    expect(judgeModelMention("@cli:opencode", KNOWN)).toEqual({
      action: "ignore",
      note: MENTION_SAME_CLI,
    });
    expect(judgeModelMention("no mention", KNOWN)).toEqual({ action: "none" });
  });

  it("does not store the same intent twice", () => {
    const once = recordMentionIntent([], { kind: "cli", id: "pi" });
    expect(recordMentionIntent(once, { kind: "cli", id: "pi" })).toEqual(once);
    expect(recordMentionIntent(once, { kind: "model", id: "pi:default" })).toHaveLength(2);
  });
});

describe("the picker token", () => {
  it("opens for @model and @cli, and not for a file mention or a quote", () => {
    expect(modelMentionTokenAt("see @model", 11)).toMatchObject({ kind: "model", query: "" });
    expect(modelMentionTokenAt("@model:glm", 10)).toMatchObject({ kind: "model", query: "glm" });
    expect(modelMentionTokenAt("@cli:", 5)).toMatchObject({ kind: "cli", query: "" });
    expect(modelMentionTokenAt("@readme", 7)).toBeNull();
    expect(modelMentionTokenAt("@modeling", 9)).toBeNull();
    expect(modelMentionTokenAt("> @model:pi", 10)).toBeNull();
  });

  it("inserts the id and filters the list", () => {
    const token = modelMentionTokenAt("@model:", 7)!;
    expect(insertModelMention("@model: now", token, "opencode:glm-5")).toBe("@model:opencode:glm-5 now");
    const choices = modelMentionChoices(
      token,
      [
        { id: "opencode:glm-5", name: "GLM 5" },
        { id: "pi:default", name: "Pi" },
      ],
      [],
    );
    expect(choices.map((choice) => choice.id)).toEqual(["opencode:glm-5", "pi:default"]);
    const filtered = modelMentionChoices({ ...token, query: "pi" }, [
      { id: "opencode:glm-5", name: "GLM 5" },
      { id: "pi:default", name: "Pi" },
    ], []);
    expect(filtered.map((choice) => choice.id)).toEqual(["pi:default"]);
  });
});
