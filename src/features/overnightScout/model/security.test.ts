import { describe, expect, it } from "vitest";
import { securityParkReason } from "./security";

describe("security park", () => {
  it("parks auth, listeners, merge approval and secrets", () => {
    expect(securityParkReason("Add auth for the desk")).toBe("auth");
    expect(securityParkReason("AUTHENTICATION flow")).toBe("auth");
    expect(securityParkReason("a network listener on the bus")).toBe("listener");
    expect(securityParkReason("Listen on a local port")).toBe("listener");
    expect(securityParkReason("Needs merge approval first")).toBe("merge");
    expect(securityParkReason("reads a secret from the store")).toBe("secret");
    expect(securityParkReason("API key rotation")).toBe("secret");
    expect(securityParkReason("access token refresh")).toBe("secret");
  });

  it("does not park ordinary words that only look close", () => {
    expect(securityParkReason("the author of the note")).toBeNull();
    expect(securityParkReason("a token budget for the summary")).toBeNull();
    expect(securityParkReason("do not merge this draft")).toBeNull();
    expect(securityParkReason("an event listener in the page")).toBeNull();
    expect(securityParkReason("")).toBeNull();
    expect(securityParkReason("   ")).toBeNull();
  });
});
