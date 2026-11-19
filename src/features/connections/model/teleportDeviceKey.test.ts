import { afterEach, describe, expect, it, vi } from "vitest";
import { sshMoveEndpoint, stableDeviceKey } from "./teleportSsh";

describe("WP-177 device key fail closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends nothing when a device key cannot be made", async () => {
    const base = stableDeviceKey();
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no digest"));
    const seen: unknown[] = [];
    await expect(
      sshMoveEndpoint(
        "connection-no-digest",
        async (_method, params) => {
          seen.push(params.deviceKey);
          return null;
        },
        "env-no-digest",
      ).read("chat-key"),
    ).rejects.toThrow(/device key/);
    expect(seen).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(base);
  });
});
