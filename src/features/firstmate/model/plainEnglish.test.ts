import { afterEach, describe, expect, it } from "vitest";
import { FIRST_MATE_CONTRACT, contractForAgents } from "./contract";
import { PLAIN_ENGLISH_RULE, __resetPlainEnglishForTests, plainEnglishEndings, savePlainEnglishEndings } from "./plainEnglish";
import { sessionInstruction } from "../../plugins/model/pstackAutopilot";

afterEach(() => __resetPlainEnglishForTests());

describe("plain-English endings", () => {
  it("is in the contract and the session instruction, on by default", () => {
    expect(plainEnglishEndings()).toBe(true);
    expect(FIRST_MATE_CONTRACT).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain("**Never edit the project.**");
    expect(sessionInstruction({ plainEnglish: plainEnglishEndings() })).toContain(PLAIN_ENGLISH_RULE);
  });

  it("the switch removes the line from what agents read and from the session instruction", () => {
    savePlainEnglishEndings(false);
    expect(plainEnglishEndings()).toBe(false);
    expect(FIRST_MATE_CONTRACT).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).not.toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain("Talk in outcomes");
    expect(contractForAgents()).toContain("**Never edit the project.**");
    expect(sessionInstruction({ plainEnglish: plainEnglishEndings() })).not.toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ pstackRoot: "/plugins/installed/pstack", plainEnglish: plainEnglishEndings() })).not.toContain(
      "no jargon, lists or headings",
    );
    savePlainEnglishEndings(true);
    expect(contractForAgents()).toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ plainEnglish: true })).toContain(PLAIN_ENGLISH_RULE);
  });
});
