// @vitest-environment happy-dom
// Settings > Accounts (E5) and the honest sign-in labels (E3): Ash sets the order and the switch himself; OAuth shows
// only where the app really runs it, and what isn't built says "Not connected yet".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));

import { AddModelForm } from "../../sessions/ui/CustomModels";
import { markAccountLimited, orderedAccounts, waterfallEnabled } from "../model/accountWaterfall";
import { saveProviderAccount, type ProviderAccount } from "../model/providerAccounts";
import { notConnectedYet, offersBrowserSignIn, signInOptions, type SignInProvider } from "../model/providerSignIn";
import { AccountOrderControls, AccountWaterfallSwitch } from "./AccountWaterfall";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
};

function renderOrder(now = Date.now()) {
  const accounts = orderedAccounts("claude");
  act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(AccountWaterfallSwitch, { provider: "claude", count: accounts.length }),
        ...accounts.map((account: ProviderAccount, index) =>
          createElement(AccountOrderControls, { key: account.id, account, index, count: accounts.length, now, usageFor: () => undefined }),
        ),
      ),
    ),
  );
}

describe("the order and the switch", () => {
  it("shows nothing for one account", () => {
    renderOrder();
    expect(host.querySelector("[data-account-waterfall]")).toBeNull();
    expect(host.querySelector("[data-account-order]")).toBeNull();
  });

  it("Ash moves an account earlier, and can turn moving on off", async () => {
    saveProviderAccount({ id: "account-b", provider: "claude", label: "Personal" });
    renderOrder();
    expect([...host.querySelectorAll("[data-account-order]")].map((el) => el.getAttribute("data-account-order"))).toEqual(["default", "account-b"]);
    expect(host.querySelector('[aria-label="Use Default account earlier"]')?.hasAttribute("disabled")).toBe(true);
    await click(host.querySelector('[aria-label="Use Personal earlier"]'));
    expect(orderedAccounts("claude").map((a) => a.id)).toEqual(["account-b", "default"]);

    const toggle = host.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    expect(waterfallEnabled("claude")).toBe(false);
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("says when a spent account is out until", () => {
    saveProviderAccount({ id: "account-b", provider: "claude", label: "Personal" });
    const now = Date.UTC(2026, 9, 21, 10, 0);
    markAccountLimited({ provider: "claude", id: "default" }, { now, resetsAt: now + 60 * 60_000 });
    renderOrder(now + 60_000);
    const out = host.querySelector('[data-account-order="default"] [data-account-out]');
    expect(out?.textContent).toMatch(/^Out until /);
    expect(host.querySelector('[data-account-order="account-b"] [data-account-out]')).toBeNull();
  });
});

describe("sign-in, honestly", () => {
  const all: SignInProvider[] = ["claude", "codex", "devin", "xai", "openrouter", "deepseek", "ollama", "custom"];

  it("offers a browser sign-in only where the app runs one", () => {
    expect(all.filter(offersBrowserSignIn)).toEqual(["claude", "codex", "devin"]);
    expect(signInOptions("codex")[0].label).toBe("Sign in with ChatGPT");
  });

  it("names xAI's sign-in as not connected yet, and never invents one for key-only providers", () => {
    expect(notConnectedYet("xai").map((o) => `${o.label}: ${o.note}`)).toEqual(["Sign in with xAI: Not connected yet. Use a key for now."]);
    for (const provider of ["openrouter", "deepseek", "ollama", "custom"] as const) expect(notConnectedYet(provider)).toEqual([]);
  });

  it("the add-a-model form shows xAI's line and no sign-in button", async () => {
    act(() => root.render(createElement(AddModelForm, { onDone: () => {}, onCancel: () => {} })));
    expect(host.querySelector('[data-provider-button]')?.getAttribute("data-provider-button")).toBe("xai");
    expect(host.querySelector('[data-signin-not-connected="xai"]')?.textContent).toBe("Sign in with xAI: Not connected yet. Use a key for now.");
    expect([...host.querySelectorAll("button")].some((b) => /sign in/i.test(b.textContent ?? ""))).toBe(false);
    await click(host.querySelector("[data-provider-button]"));
    await click(host.querySelector('[data-provider-choice="deepseek"]'));
    expect(host.querySelector("[data-signin-not-connected]")).toBeNull();
  });
});
