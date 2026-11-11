// Round-5 review repro (PR #213), LOW. Secret cards are Once or No (round 5), but Settings still shows a switch that
// promises "Always" for programs that can run any code. The person turns it on and believes a card can now be answered
// "Always". The test asserts the safe behaviour, so a failure is the finding.
import { describe, expect, it } from "vitest";
import { ANY_CODE_LABEL, ANY_CODE_WARNING } from "./secrets";

describe("round 5 repro: no Always that no card offers", () => {
  it("the Settings switch does not promise an 'Always' answer", () => {
    expect(`${ANY_CODE_LABEL} ${ANY_CODE_WARNING}`).not.toMatch(/always/i);
  });
});
