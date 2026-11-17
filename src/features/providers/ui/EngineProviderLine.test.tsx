import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineProviderLine, engineProviderWords } from "./EngineProviderLine";

describe("a coding tool's row in Settings, when the engine runs it", () => {
  it("says the version and whether anyone is signed in", () => {
    expect(engineProviderWords(12, { version: "2.1.50", signedIn: false })).toEqual({ before: "12 models available. Version 2.1.50. Not signed in.", after: "" });
    expect(engineProviderWords(1, { signedIn: true })).toEqual({ before: "1 model available. Signed in.", after: "" });
    // The engine cannot tell: nothing is claimed either way.
    expect(engineProviderWords(3, {})).toEqual({ before: "3 models available.", after: "" });
    expect(engineProviderWords(3, { note: "Example: the CLI is too old." }).after).toBe(" Example: the CLI is too old.");
  });

  it("names the account the way the usage menu does, the email kept private", () => {
    const html = renderToStaticMarkup(<EngineProviderLine models={12} facts={{ version: "2.1.50", signedIn: true, plan: "Claude Max", email: "example@example.com" }} />);
    expect(html).toContain("12 models available. Version 2.1.50.");
    expect(html).toContain("Signed in: ");
    expect(html).toContain("Claude Max");
  });
});
