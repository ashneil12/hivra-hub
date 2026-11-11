import { describe, expect, it } from "vitest";
import { oneTimeProjectChoices } from "./OneTimeSchedulePanel";

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
});
