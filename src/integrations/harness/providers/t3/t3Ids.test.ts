import { describe, expect, it } from "vitest";
import { isPersistableId } from "../../../../features/sessions/model/persistableId";
import { t3AppId, t3EngineId } from "./t3Ids";

describe("the engine's ids in a saved chat", () => {
  it("gives the chat an id it can keep and reads the engine's own back from it", () => {
    for (const id of ["run:thread:4f1c:1", "thread:subagent:0123456789abcdef", "t3x_looks-wrapped", "a/b+c=?"]) {
      const kept = t3AppId(id);
      expect(isPersistableId(kept)).toBe(true);
      expect(t3EngineId(kept)).toBe(id);
    }
  });

  it("leaves an id the chat can already keep as it is", () => {
    const thread = "0b6f7c1e-1f0a-4a55-9a43-7f0d2c3b4a5e";
    expect(t3AppId(thread)).toBe(thread);
    expect(t3EngineId(thread)).toBe(thread);
  });
});
