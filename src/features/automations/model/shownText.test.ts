import { describe, expect, it } from "vitest";
import { automationFilterLabel, scrubShownText } from "./shownText";

describe("scrubShownText", () => {
  it("replaces a token in a filter label and leaves a plain name", () => {
    const key = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
    const token = `ghp_${"A".repeat(30)}`;
    expect(automationFilterLabel(`Audit ${key}`)).toBe("Audit [secret removed]");
    expect(automationFilterLabel(`Audit ${key}`)).not.toContain("sk-ant-");
    expect(scrubShownText(`https://git:${token}@github.com/acme/web`)).not.toContain("ghp_");
    expect(scrubShownText(`https://git:${token}@github.com/acme/web`)).toContain(
      "[secret removed]",
    );
    expect(automationFilterLabel("  ")).toBe("Automation");
    expect(automationFilterLabel("Inbox watch")).toBe("Inbox watch");
  });
});
