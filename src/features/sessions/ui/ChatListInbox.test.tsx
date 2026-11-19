// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatListInboxNotice, ChatListShelves, SnoozeTimeDialog } from "./ChatListInbox";
import { resetInboxStoreForTests, settleChats } from "../model/chatListInboxStore";

afterEach(() => {
  resetInboxStoreForTests();
});

describe("chat list inbox shelves", () => {
  it("names the shelves, the way back, and the undo notice without a dash", () => {
    const shelves = renderToStaticMarkup(
      <ChatListShelves
        settled={[{ id: "a", title: "Alpha" }]}
        snoozed={[{ id: "b", title: "Beta" }]}
        onOpen={() => {}}
        onUnsettle={() => {}}
        onUnsnooze={() => {}}
      />,
    );
    expect(shelves).toContain("Settled");
    expect(shelves).toContain("Snoozed");
    expect(shelves).toContain("data-settled-shelf");
    expect(shelves).toContain("data-snoozed-shelf");
    expect(shelves).not.toMatch(/[—–]/);

    settleChats(["a"], 10);
    const notice = renderToStaticMarkup(<ChatListInboxNotice />);
    expect(notice).toContain('role="status"');
    expect(notice).toContain("Settled this chat.");
    expect(notice).toContain("Undo");
    expect(notice).not.toMatch(/[—–]/);

    const dialog = renderToStaticMarkup(<SnoozeTimeDialog onSnooze={() => {}} onClose={() => {}} />);
    expect(dialog).toContain("Snooze until");
    expect(dialog).toContain(">Snooze<");
    expect(dialog).toContain("Cancel");
    expect(dialog).not.toMatch(/[—–]/);
  });
});
