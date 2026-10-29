import { describe, expect, it } from "vitest";
import { chatQuestion, secretActionTried } from "./chatQuestions";

const turn = (command: string) => [
  {
    role: "user" as const,
    text: "think the resend key leaked. can u get it rotated",
  },
  { role: "assistant" as const, text: "", tool: { command } as never },
];

describe("r72 (blind p01): the red row names the part that tried the secret action", () => {
  it("names `env`, not the find that came first", () => {
    const tried = secretActionTried(
      turn(
        "find . -type f -not -path './node_modules/*' | head -100; echo '---env names---'; env",
      ),
    );
    expect(tried).toBe("env");
  });

  it("names the vercel env step of a chain", () => {
    expect(
      secretActionTried(
        turn("cd api && vercel env add RESEND_API_KEY production"),
      ),
    ).toBe("vercel env add RESENDAPIKEY production");
  });

  it("a single command is shown as before, values hidden", () => {
    expect(secretActionTried(turn("printenv RESEND_API_KEY"))).toBe(
      "printenv RESENDAPIKEY",
    );
    expect(secretActionTried(turn("ls -la; git status"))).toBeUndefined();
  });

  it("the finished turn reads as a red Needs Ash (provide) row with that part", () => {
    const q = chatQuestion({ busy: false, blocks: turn("rg resend .; env") });
    expect(q?.question).toContain("`env`");
    expect(q?.redLine).toBe(true);
  });
});
