// @vitest-environment happy-dom
// G6: "Show code tools" is an app setting (settings.ts, carried by an export), no longer one window's own key. The value
// a window kept under the old key is read once.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { PORTABLE_SETTINGS } from "../../portable/model/setupDoc";

const OLD_KEY = "monocode:show-code-tools";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => localStorage.clear());

it("is kept in the app settings, so a reload keeps it", async () => {
  const settings = await import("./settings");
  const tools = await import("./codeTools");
  tools.setShowCodeTools(IS_HUB_BUNDLE);
  expect(localStorage.getItem(settings.SHOW_CODE_TOOLS_KEY)).toBe(IS_HUB_BUNDLE ? "1" : "0");
  vi.resetModules();
  const reloaded = await import("./codeTools");
  expect(reloaded.showCodeTools()).toBe(IS_HUB_BUNDLE);
  expect((await import("./settings")).loadShowCodeTools(!IS_HUB_BUNDLE)).toBe(IS_HUB_BUNDLE);
});

it("travels with an export like the other app settings", async () => {
  const settings = await import("./settings");
  expect(PORTABLE_SETTINGS).toContain(settings.SHOW_CODE_TOOLS_KEY);
  expect(settings.SHOW_CODE_TOOLS_KEY).not.toBe(OLD_KEY);
});

it("reads the old key once, then lets it go", async () => {
  // The opposite of the default, so the value can only have come from the old key.
  localStorage.setItem(OLD_KEY, IS_HUB_BUNDLE ? "0" : "1");
  const settings = await import("./settings");
  expect(settings.loadShowCodeTools(!IS_HUB_BUNDLE)).toBe(IS_HUB_BUNDLE ? false : true);
  expect(localStorage.getItem(OLD_KEY)).toBeNull();
  expect(localStorage.getItem(settings.SHOW_CODE_TOOLS_KEY)).toBe(IS_HUB_BUNDLE ? "0" : "1");
  // A later change is the setting's alone; the old key is not read again.
  settings.saveShowCodeTools(IS_HUB_BUNDLE);
  localStorage.setItem(OLD_KEY, IS_HUB_BUNDLE ? "0" : "1");
  expect(settings.loadShowCodeTools(!IS_HUB_BUNDLE)).toBe(IS_HUB_BUNDLE);
});

it("starts hidden in the hub and shown upstream, and every listener hears a change", async () => {
  const settings = await import("./settings");
  const tools = await import("./codeTools");
  expect(tools.showCodeTools()).toBe(!IS_HUB_BUNDLE);
  let heard = 0;
  const stop = settings.subscribeShowCodeTools(() => {
    heard += 1;
  });
  tools.setShowCodeTools(IS_HUB_BUNDLE);
  stop();
  expect(heard).toBe(1);
  expect(tools.showCodeTools()).toBe(IS_HUB_BUNDLE);
});
