// r51 (Alfred's r50 blind run): a chat named from "The current branch is **pm/pages-live**..." showed the stars in the
// header, the conversation list and the delete confirm. Titles are plain text when made, and old ones show plain.
import { describe, expect, it } from "vitest";
import { autoTitle } from "../../features/hub/model/hubChats";
import { formatSessionTitle, sessionDisplayTitle, titleFromPrompt } from "../../features/sessions/model/session";
import { confirmTitleName } from "../ui/ConfirmDelete";
import { plainTitle } from "./plainTitle";

const RAW = "The current branch is **pm/pages-live** and `main` is [behind](https://x.test)";
const PLAIN = "The current branch is pm/pages-live and main is behind";

describe("chat titles are plain text (r51)", () => {
  it("plainTitle drops markdown and keeps the words, on one line", () => {
    expect(plainTitle(RAW)).toBe(PLAIN);
    expect(plainTitle("## _Fix_ the ~~old~~ FAQ\n- now")).toBe("Fix the old FAQ now");
    expect(plainTitle("snake_case_name stays")).toBe("snake_case_name stays");
  });
  it("a new chat's title, a generated title and a room conversation's title are made plain", () => {
    expect(titleFromPrompt(RAW, "claude")).toBe(`Claude · ${PLAIN}`.replace("Claude", titleFromPrompt("x", "claude").split(" · ")[0]));
    expect(formatSessionTitle("claude", "**Pages** live")).toMatch(/· Pages live$/);
    expect(autoTitle("**Ship** the `r51` build")).toBe("Ship the r51 build");
  });
  it("a title saved with markdown before this shows plain in the header, the list and the confirm", () => {
    const old = formatSessionTitle("claude", "x").replace(/x$/, RAW);
    expect(sessionDisplayTitle(old, "claude")).toBe(PLAIN);
    expect(sessionDisplayTitle(RAW, "claude")).toBe(PLAIN);
    expect(confirmTitleName(RAW, 200)).toBe(PLAIN);
  });
});
