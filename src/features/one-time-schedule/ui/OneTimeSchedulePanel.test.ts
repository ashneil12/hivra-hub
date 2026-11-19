import { describe, expect, it } from "vitest";
import { oneTimeConfirmWarning, oneTimeProjectChoices } from "./OneTimeSchedulePanel";

describe("one time project choices", () => {
  it("keeps one row per project and drops a blank path or label", () => {
    expect(
      oneTimeProjectChoices([
        { id: "C:\\Work\\Demo", label: "Demo" },
        { id: "c:/work/demo", label: "Again" },
        { id: "", label: "Missing" },
        { id: "/work/demo", label: "" },
        { id: "/work/项目", label: "项目" },
        { id: "/work/项目", label: "项目 again" },
      ]),
    ).toEqual([
      { id: "C:\\Work\\Demo", label: "Demo" },
      { id: "/work/项目", label: "项目" },
    ]);
  });

  it("tells a dev copy that it does not run schedules", () => {
    expect(oneTimeConfirmWarning(true)).toMatch(/closed at this time/);
    expect(oneTimeConfirmWarning(false)).toMatch(/does not run one-time schedules/);
    expect(oneTimeConfirmWarning(false)).not.toMatch(/closed at this time/);
    expect(oneTimeConfirmWarning(false)).not.toMatch(/[—–]/);
  });
});
