import { describe, expect, it } from "vitest";
import { accessLabel, lastUsedLabel } from "./connected";

describe("connected app labels", () => {
  it("names the two grants a person can give", () => {
    expect(accessLabel(false)).toBe("Read only");
    expect(accessLabel(true)).toBe("Read and task writes");
  });

  it("formats last used in UTC and treats zero as a real time", () => {
    expect(lastUsedLabel(null)).toBe("Not used yet");
    expect(lastUsedLabel(0)).toBe("1970-01-01 00:00");
    expect(lastUsedLabel(1_700_000_000_000)).toBe("2023-11-14 22:13");
  });
});
