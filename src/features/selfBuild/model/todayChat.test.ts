// @vitest-environment happy-dom
// today_change from a Mono's chat. The preview builds ran in Ash OS, retired with the bridge (WP-04): outside the dev
// stub the Mono hears it isn't wired; inside it, the whole path from preview to Apply still works.
import { beforeEach, expect, it } from "vitest";
import { applyTodayFromChat, openTodayChatPreview, OPEN_EDIT_TODAY, todayChatPreview, todayFromChat, todayPreviewWaiting } from "./todayChat";

const roster = [{ id: "alfred" }];
const me = { monoId: "alfred", name: "Alfred" };
const ask = "on my Today board, move the MonoCode Hub card to the first spot";
beforeEach(() => localStorage.clear());

it("builds the Today preview from the Mono's chat and puts it in front of Ash; Apply needs Ash's yes", async () => {
  const out = await todayFromChat({ ask }, me, { roster, stub: true });
  expect(out.note).toMatch(/Apply and Discard/);
  expect(todayChatPreview(out.previewId)?.prompt).toBe(ask);

  const tabs: string[] = [];
  window.addEventListener(OPEN_EDIT_TODAY, (e) => tabs.push((e as CustomEvent).detail));
  openTodayChatPreview(out.previewId);
  expect(tabs).toEqual(["today"]);
  expect(todayPreviewWaiting()).toBe("today");

  await expect(applyTodayFromChat(out.previewId, me, () => false, { stub: true })).rejects.toThrow(/hasn't answered/);
  await expect(applyTodayFromChat(out.previewId, { monoId: "cos" }, () => true, { stub: true })).rejects.toThrow(/another Mono/);
  expect(await applyTodayFromChat(out.previewId, me, () => true, { stub: true })).toMatchObject({ applied: out.title });
  expect(todayChatPreview(out.previewId)).toBeUndefined();
  expect(todayPreviewWaiting()).toBeUndefined();
});

it("project cards follow the project order: projectOrder true builds it as the hub's order change, opened on that tab", async () => {
  const out = await todayFromChat({ ask, projectOrder: true }, me, { roster, stub: true });
  expect(out.note).toMatch(/sidebar's too/);
  const tabs: string[] = [];
  window.addEventListener(OPEN_EDIT_TODAY, (e) => tabs.push((e as CustomEvent).detail));
  openTodayChatPreview(out.previewId);
  expect(tabs).toEqual(["hub"]);
  await expect(todayFromChat({ ask, projectOrder: "yes" }, me, { roster })).rejects.toThrow(/projectOrder/);
});

it("a code change or an unwired build comes back to the Mono in plain words; an empty ask is refused", async () => {
  await expect(todayFromChat({ ask: " " }, me, { roster })).rejects.toThrow(/ask must be/);
  await expect(todayFromChat({ ask: "make the cards bigger" }, me, { roster, stub: true })).rejects.toThrow(/needs a code change: hand it to hub_change/);
  await expect(todayFromChat({ ask }, me, { roster, stub: false })).rejects.toThrow(/isn't wired up/);
});
