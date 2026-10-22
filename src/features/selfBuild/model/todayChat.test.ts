// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { HubCallError } from "../../hub/model/hubTransport";
import { stubPreview } from "../../hubChange/model/hubChange";
import { applyTodayFromChat, openTodayChatPreview, OPEN_EDIT_TODAY, todayChatPreview, todayFromChat, todayPreviewWaiting } from "./todayChat";

const roster = [{ id: "alfred" }];
const me = { monoId: "alfred", name: "Alfred" };
const ask = "on my Today board, move the MonoCode Hub card to the first spot";
beforeEach(() => localStorage.clear());

it("builds the Today preview from the Mono's chat, waiting out a slow build, and puts it in front of Ash", async () => {
  const preview = { ...stubPreview({ flow: "today", projectId: "today", monoId: "alfred", prompt: ask }), by: "Alfred" };
  let n = 0;
  const call = vi.fn(async (action: string) => {
    if (action !== "ash-hub-change-preview") return {};
    if (++n < 3) throw new HubCallError("error", "Alfred is still building this preview. Press Try again in a moment to see it.");
    return preview;
  });
  const transport = { call: call as never, openFeed: () => () => undefined };
  const out = await todayFromChat({ ask }, me, { roster, transport, sleep: async () => undefined });
  expect(call).toHaveBeenNthCalledWith(1, "ash-hub-change-preview", { flow: "today", projectId: "today", monoId: "alfred", prompt: ask, wait: 30 });
  expect(out.previewId).toBe(preview.previewId);
  expect(out.note).toMatch(/Apply and Discard/);
  expect(todayChatPreview(preview.previewId)?.prompt).toBe(ask);

  const tabs: string[] = [];
  window.addEventListener(OPEN_EDIT_TODAY, (e) => tabs.push((e as CustomEvent).detail));
  openTodayChatPreview(preview.previewId);
  expect(tabs).toEqual(["today"]);
  expect(todayPreviewWaiting()).toBe("today");

  // Ash's yes in chat: Apply goes through Ash OS, and the preview leaves the bar.
  await expect(applyTodayFromChat(preview.previewId, me, () => false, { transport })).rejects.toThrow(/hasn't answered/);
  await expect(applyTodayFromChat(preview.previewId, { monoId: "cos" }, () => true, { transport })).rejects.toThrow(/another Mono/);
  expect(await applyTodayFromChat(preview.previewId, me, () => true, { transport })).toMatchObject({ applied: preview.title });
  expect(call).toHaveBeenCalledWith("ash-hub-change-apply", { previewId: preview.previewId });
  expect(todayChatPreview(preview.previewId)).toBeUndefined();
  expect(todayPreviewWaiting()).toBeUndefined();
});

it("project cards follow the project order: projectOrder true builds it as the hub's order change, opened on that tab and applied there", async () => {
  const preview = { ...stubPreview({ flow: "hub", projectId: "today", monoId: "alfred", prompt: ask }), by: "Alfred" };
  const call = vi.fn(async (action: string) => (action === "ash-hub-change-preview" ? preview : {}));
  const transport = { call: call as never, openFeed: () => () => undefined };
  const out = await todayFromChat({ ask, projectOrder: true }, me, { roster, transport });
  expect(call).toHaveBeenCalledWith("ash-hub-change-preview", { flow: "hub", projectId: "today", monoId: "alfred", prompt: ask, wait: 30 });
  expect(out.note).toMatch(/sidebar's too/);
  const tabs: string[] = [];
  window.addEventListener(OPEN_EDIT_TODAY, (e) => tabs.push((e as CustomEvent).detail));
  openTodayChatPreview(preview.previewId);
  expect(tabs).toEqual(["hub"]);
  expect(todayPreviewWaiting()).toBe("hub");
  await applyTodayFromChat(preview.previewId, me, () => true, { transport });
  expect(call).toHaveBeenCalledWith("ash-hub-change-apply", { previewId: preview.previewId });
  await expect(todayFromChat({ ask, projectOrder: "yes" }, me, { roster })).rejects.toThrow(/projectOrder/);
});

it("a code change or a refusal comes back to the Mono in plain words; an empty ask is refused", async () => {
  await expect(todayFromChat({ ask: " " }, me, { roster })).rejects.toThrow(/ask must be/);
  const transport = { call: (async () => { throw new HubCallError("error", "Alfred says this is a change to the app itself: the card's look is drawn by the app."); }) as never, openFeed: () => () => undefined };
  await expect(todayFromChat({ ask }, me, { roster, transport })).rejects.toThrow(/needs a code change: hand it to hub_change/);
});
