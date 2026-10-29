import { describe, expect, it } from "vitest";
import { withoutEmDashes } from "./noEmDash";

describe("withoutEmDashes (r74: chat replies drop em dashes at display, like room posts)", () => {
  it("swaps spaced and bare em dashes, and spaced en dashes, for a comma", () => {
    expect(withoutEmDashes("I won't rotate it — you do that in Resend.")).toBe("I won't rotate it, you do that in Resend.");
    expect(withoutEmDashes("the key—the new one—goes in Settings")).toBe("the key, the new one, goes in Settings");
    expect(withoutEmDashes("done – tests pass")).toBe("done, tests pass");
  });

  it("keeps ranges and plain hyphens", () => {
    expect(withoutEmDashes("pages 10–14, a well-known fix")).toBe("pages 10–14, a well-known fix");
  });

  it("leaves code as written: fenced blocks and inline code", () => {
    const text = "Run it — then check:\n```sh\necho 'a — b'\n```\nThe flag `--x — y` stays — mostly.";
    expect(withoutEmDashes(text)).toBe("Run it, then check:\n```sh\necho 'a — b'\n```\nThe flag `--x — y` stays, mostly.");
  });

  it("returns the same string when there is nothing to swap", () => {
    const text = "Nothing to change here.";
    expect(withoutEmDashes(text)).toBe(text);
  });
});
