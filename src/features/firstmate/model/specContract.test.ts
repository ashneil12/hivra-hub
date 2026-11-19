// PT-6: what a first mate is told about the spec of record (contract.md, "Delegating well"). The tool texts say the same in
// src-tauri/src/mcp_server.rs and firstmate/spec_mcp.rs, and their tests are in Rust.
import { describe, expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "./contract";
import { SPEC_RULE } from "./briefSpec";

describe("the first mate contract on the spec of record (PT-6)", () => {
  const start = FIRST_MATE_CONTRACT.indexOf("## Delegating well");
  // The file wraps its lines; the model reads them as one.
  const section = FIRST_MATE_CONTRACT.slice(start, FIRST_MATE_CONTRACT.indexOf("\n## ", start + 5)).replace(/\s+/g, " ");
  const bullet = section.slice(section.indexOf("The spec comes before the code."), section.indexOf("A worker has no memory of this chat."));

  it("says a correction or new detail must carry the section it changes, spec first and code second", () => {
    expect(bullet).toContain("The spec comes before the code.");
    expect(bullet).toContain('every correction the person makes ("add detail", "change this")');
    expect(bullet).toContain("you must send the section it changes in `spec`");
    expect(bullet).toContain("up to three `{file, section, text}` parts");
    expect(bullet).toContain("`docs/spec/`");
    expect(bullet).toContain("The worker updates that section first, in its own commit, then changes the code to match it.");
    // The same words the worker's brief carries.
    expect(SPEC_RULE).toBe("Update the spec section first, in its own commit, then change the code to match it.");
  });

  it("says what the app does with it, and that the first part creates the file and its index line", () => {
    expect(bullet).toContain("fails the round when the spec file did not change or the section does not hold your text");
    expect(bullet).toContain("notes it when the spec was not committed first");
    expect(bullet).toContain("creates the file and its line in the index");
  });

  it("keeps spec_start for when the person asks, and a task that changes no behaviour out of it", () => {
    expect(bullet).toContain("Leave `spec` out of a task that changes no behaviour.");
    expect(bullet).toContain("only when the person asks: then call `spec_start`, once");
  });

  it("is in Hivra's own section, in plain words with no dash", () => {
    expect(start).toBeGreaterThan(0);
    expect(bullet.length).toBeGreaterThan(200);
    expect(bullet).not.toMatch(/[—–]/);
  });
});
