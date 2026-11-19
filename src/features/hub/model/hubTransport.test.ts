// toHubError: how the store reads any failure (hubStore.ts, projectActions.ts). Kept from the retired bridge's tests
// (WP-04 review): the shape a transport rejects with, and everything else as "couldn't be read".
import { describe, expect, it } from "vitest";
import { HubCallError, toHubError } from "./hubTransport";

describe("toHubError", () => {
  it("keeps a HubCallError as it is", () => {
    const own = new HubCallError("refused", "The app doesn't do that any more.");
    expect(toHubError(own)).toBe(own);
  });

  it("reads a transport's {kind, message} rejection, and tells down from said-no", () => {
    const down = toHubError({ kind: "timeout", message: "slow" });
    expect(down).toMatchObject({ kind: "timeout", message: "slow" });
    expect(down.isDown).toBe(true);
    const said = toHubError({ kind: "error", message: "Unknown project: x" });
    expect(said).toBeInstanceOf(HubCallError);
    expect(said).toMatchObject({ kind: "error", message: "Unknown project: x" });
    expect(said.isDown).toBe(false);
  });

  it("treats anything else (no Tauri, a string, null, an unknown kind) as couldn't be read", () => {
    for (const odd of ["boom", null, undefined, { kind: "weird", message: "x" }, { kind: "error", message: 3 }]) {
      const e = toHubError(odd);
      expect(e.kind).toBe("unreachable");
      expect(e.message).toBe("The app couldn't be read.");
    }
    // An Error keeps its own words.
    expect(toHubError(new TypeError("Cannot read properties of undefined (reading 'invoke')")).message).toBe(
      "Cannot read properties of undefined (reading 'invoke')",
    );
  });
});
