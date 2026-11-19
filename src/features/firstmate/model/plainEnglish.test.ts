import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_MATE_CONTRACT, contractForAgents, withFirstMateContract } from "./contract";
import { PLAIN_ENGLISH_KEY, PLAIN_ENGLISH_RULE, __resetPlainEnglishForTests, plainEnglishEndings, savePlainEnglishEndings } from "./plainEnglish";
import { sessionInstruction } from "../../plugins/model/pstackAutopilot";

afterEach(() => {
  __resetPlainEnglishForTests();
  vi.unstubAllGlobals();
});

describe("plain-English endings", () => {
  it("is in the contract and the session instruction, on by default", () => {
    expect(plainEnglishEndings()).toBe(true);
    expect(FIRST_MATE_CONTRACT).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain("**Never write to a project.**");
    expect(sessionInstruction({ plainEnglish: plainEnglishEndings() })).toContain(PLAIN_ENGLISH_RULE);
  });

  it("the switch removes the line from what agents read and from the session instruction", () => {
    savePlainEnglishEndings(false);
    expect(plainEnglishEndings()).toBe(false);
    expect(FIRST_MATE_CONTRACT).toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).not.toContain(PLAIN_ENGLISH_RULE);
    expect(contractForAgents()).toContain("Talk in outcomes");
    expect(contractForAgents()).toContain("**Never write to a project.**");
    expect(sessionInstruction({ plainEnglish: plainEnglishEndings() })).not.toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ pstackRoot: "/plugins/installed/pstack", plainEnglish: plainEnglishEndings() })).not.toContain(
      "no jargon, lists or headings",
    );
    savePlainEnglishEndings(true);
    expect(contractForAgents()).toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ plainEnglish: true })).toContain(PLAIN_ENGLISH_RULE);
  });

  it("drops the line from every prompt that carries the contract", () => {
    savePlainEnglishEndings(false);
    const carried = withFirstMateContract(`You are the lead.\n\n${FIRST_MATE_CONTRACT}`);
    expect(carried).toContain("You are the lead.");
    expect(carried).toContain("**Never write to a project.**");
    expect(carried).not.toContain(PLAIN_ENGLISH_RULE);
    expect(carried.split("# The first mate contract").length - 1).toBe(1);
    const built = withFirstMateContract("You are the lead.");
    expect(built).toContain("You are the lead.");
    expect(built).toContain("**Never write to a project.**");
    expect(built).not.toContain(PLAIN_ENGLISH_RULE);
    savePlainEnglishEndings(true);
    expect(withFirstMateContract("You are the lead.")).toContain(PLAIN_ENGLISH_RULE);
  });

  it("reads the stored flag each time, so another window's change wins", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    });
    savePlainEnglishEndings(true);
    expect(plainEnglishEndings()).toBe(true);
    store.set(PLAIN_ENGLISH_KEY, "0");
    expect(plainEnglishEndings()).toBe(false);
    expect(contractForAgents()).not.toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ plainEnglish: plainEnglishEndings() })).not.toContain(PLAIN_ENGLISH_RULE);
  });
});
