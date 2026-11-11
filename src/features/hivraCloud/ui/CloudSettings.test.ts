// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAddMachineRequest } from "../model/addMachine";
import { CLOUD_OFF, CloudSaveConflict, type CloudApi, type CloudStatus } from "../model/cloud";
import { CloudSettings } from "./CloudSettings";

const ready: CloudStatus = {
  state: "ready",
  enabled: true,
  endpoint: "https://cloud.example",
  revision: 2,
  signedIn: false,
  message: null,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function switchButton() {
  return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
}

function field() {
  return container.querySelector<HTMLInputElement>('input[aria-label="Hivra Cloud address"]')!;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function api(overrides: Partial<CloudApi> = {}): CloudApi {
  return {
    status: vi.fn(async () => CLOUD_OFF),
    save: vi.fn(async () => CLOUD_OFF),
    signIn: vi.fn(async () => ready),
    signOut: vi.fn(async () => CLOUD_OFF),
    account: vi.fn(async () => ({ status: "fresh", plan: "pro", machineLimit: 2, notice: null })),
    pair: vi.fn(async () => ({ id: "m1", label: "Desk", sshHost: "me@cloud" })),
    ...overrides,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(cloud: CloudApi) {
  await act(async () => {
    root.render(createElement(CloudSettings, { api: cloud }));
  });
}

describe("Hivra Cloud settings", () => {
  it("stays off and contacts nothing until the person turns it on", async () => {
    let status = deferred<CloudStatus>();
    const cloud = api({ status: vi.fn(() => status.promise) });
    await render(cloud);
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(switchButton().disabled).toBe(true);
    expect(field().value).toBe("");
    expect(container.querySelector('[data-screen="sign-in"]')).toBeNull();
    expect(cloud.signIn).not.toHaveBeenCalled();
    expect(cloud.account).not.toHaveBeenCalled();
    expect(cloud.pair).not.toHaveBeenCalled();
    expect(cloud.save).not.toHaveBeenCalled();

    status.resolve(CLOUD_OFF);
    await act(async () => {
      await status.promise;
    });
    expect(switchButton().disabled).toBe(false);
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(cloud.save).not.toHaveBeenCalled();
  });

  it("does not save an address the app would refuse, and does not turn on", async () => {
    const cloud = api();
    await render(cloud);
    await settle();
    await typeInto(field(), "http://cloud.example");
    await act(async () => switchButton().click());
    expect(container.textContent).toContain("The Hivra Cloud address must be https, or http to this Mac.");
    expect(cloud.save).not.toHaveBeenCalled();
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(cloud.signIn).not.toHaveBeenCalled();
  });

  it("saves an empty address without signing in", async () => {
    const saved: CloudStatus = {
      state: "no_endpoint",
      enabled: true,
      endpoint: "",
      revision: 1,
      signedIn: false,
      message: null,
    };
    const cloud = api({ save: vi.fn(async () => saved) });
    await render(cloud);
    await settle();
    await act(async () => switchButton().click());
    await settle();
    expect(cloud.save).toHaveBeenCalledWith(true, "", 0);
    expect(cloud.signIn).not.toHaveBeenCalled();
    expect(cloud.account).not.toHaveBeenCalled();
    expect(cloud.pair).not.toHaveBeenCalled();
    expect(container.querySelector('[data-screen="sign-in"]')).toBeNull();
    expect(container.textContent).toContain("Add an address before signing in.");
  });

  it("shows sign-in, then the machine list, and hands the SSH address to Add machine", async () => {
    const signedIn: CloudStatus = { ...ready, signedIn: true };
    const cloud = api({
      status: vi.fn(async () => ready),
      signIn: vi.fn(async () => signedIn),
    });
    const handed = vi.fn();
    const stop = onAddMachineRequest(handed);
    await render(cloud);
    await settle();
    const signIn = container.querySelector<HTMLElement>('[data-screen="sign-in"]')!;
    expect(signIn.textContent).toContain("Sign in");
    await act(async () => signIn.querySelector("button")!.click());
    await settle();
    expect(cloud.signIn).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-screen="machines"]')).not.toBeNull();
    expect(container.textContent).toContain("pro");

    const code = container.querySelector<HTMLInputElement>('input[aria-label="Pairing code"]')!;
    await typeInto(code, "ABCD-1234");
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-action="pair"]')!.click());
    await settle();
    expect(cloud.pair).toHaveBeenCalledWith("ABCD-1234");
    expect(container.textContent).toContain("Desk");
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-action="add-machine"]')!.click());
    expect(handed).toHaveBeenCalledWith({ target: "me@cloud", name: "Desk" });
    expect(container.textContent).not.toContain("tok-123");
    stop();
  });

  it("shows the account failure once and still lets the person pair", async () => {
    const signedIn: CloudStatus = { ...ready, signedIn: true };
    const cloud = api({
      status: vi.fn(async () => signedIn),
      account: vi.fn(async () => ({
        status: "unavailable",
        plan: null,
        machineLimit: null,
        notice: "Hivra Cloud can't be reached right now. Your own machines still work.",
      })),
    });
    await render(cloud);
    await settle();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Your own machines still work.");
    expect(container.querySelector('input[aria-label="Pairing code"]')).not.toBeNull();
    expect(container.querySelector('[data-screen="machines"]')).not.toBeNull();
  });

  it("does not wait on the account check before showing the machine list", async () => {
    const signedIn: CloudStatus = { ...ready, signedIn: true };
    const account = deferred<unknown>();
    const cloud = api({
      status: vi.fn(async () => signedIn),
      account: vi.fn(() => account.promise),
    });
    await render(cloud);
    await settle();
    expect(container.querySelector('[data-screen="machines"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Pairing code"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    account.resolve({ status: "fresh", plan: null, machineLimit: null, notice: null });
    await act(async () => {
      await account.promise;
    });
  });

  it("ignores a sign-in that finishes after the switch is turned off", async () => {
    const pending = deferred<CloudStatus>();
    const cloud = api({
      status: vi.fn(async () => ready),
      signIn: vi.fn(() => pending.promise),
      save: vi.fn(async () => ({ ...CLOUD_OFF, revision: 3 })),
    });
    await render(cloud);
    await settle();
    await act(async () => container.querySelector('[data-screen="sign-in"] button')!.click());
    await act(async () => switchButton().click());
    await settle();
    pending.resolve({ ...ready, signedIn: true, revision: 2 });
    await act(async () => {
      await pending.promise;
    });
    expect(container.querySelector('[data-screen="machines"]')).toBeNull();
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(cloud.signOut).toHaveBeenCalled();
  });

  it("reloads when another window saved first", async () => {
    const latest: CloudStatus = { ...ready, endpoint: "https://other.example", revision: 9, signedIn: false };
    const cloud = api({
      status: vi.fn(async () => CLOUD_OFF),
      save: vi.fn(async () => {
        throw new CloudSaveConflict();
      }),
    });
    cloud.status = vi
      .fn()
      .mockResolvedValueOnce(CLOUD_OFF)
      .mockResolvedValueOnce(latest);
    await render(cloud);
    await settle();
    await typeInto(field(), "https://cloud.example");
    await act(async () => {
      field().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(field().value).toBe("https://other.example");
    expect(container.textContent).toContain("changed somewhere else");
    expect(cloud.save).toHaveBeenCalledTimes(1);
  });
});

