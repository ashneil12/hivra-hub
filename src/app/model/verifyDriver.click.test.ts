// @vitest-environment happy-dom
// ash-day steps 13-16: the bench clicks Apply, Discard, Undo or Cancel the way Ash does, and never a delete.
import { afterEach, expect, it } from "vitest";
import { clickButton, NEVER_CLICK, visibleButtons } from "./verifyDriver";

afterEach(() => {
  document.body.innerHTML = "";
});

it("lists the buttons Ash can see in the main pane and dialogs, not hidden ones", () => {
  document.body.innerHTML = `<nav><button>Sidebar thing</button></nav><main><button>Apply</button><button hidden>Ghost</button><button disabled>Discard</button></main><div role="dialog"><button aria-label="Cancel">x</button></div>`;
  expect(visibleButtons()).toEqual([
    { label: "Apply", disabled: false },
    { label: "Discard", disabled: true },
    { label: "Cancel", disabled: false },
  ]);
});

it("clicks the newest matching button, and refuses deletes and disabled buttons", () => {
  document.body.innerHTML = `<main><button id="a">Apply</button><button id="b">Apply</button><button disabled>Discard</button></main><div role="alertdialog"><button id="del">Delete for good</button><button id="no">Cancel</button></div>`;
  const clicks: string[] = [];
  for (const el of document.querySelectorAll("button")) el.addEventListener("click", () => clicks.push(el.id || el.textContent!));
  expect(clickButton("apply")).toEqual({ ok: true, clicked: "Apply" });
  expect(clicks).toEqual(["b"]);
  expect(clickButton("Delete for good").ok).toBe(false);
  expect(clickButton("Discard").ok).toBe(false);
  expect(clickButton("Cancel").ok).toBe(true);
  expect(clicks).toEqual(["b", "no"]);
});

it("sees and clicks the change bar's buttons, which sit in their own root outside <main> (run 24bf AD14/AD15)", () => {
  document.body.innerHTML = `<main><button>Send</button></main><div data-change-bar><button>Now</button><button>Preview</button><button id="apply">Apply</button><button>Discard</button></div>`;
  expect(visibleButtons().map((b) => b.label)).toEqual(["Send", "Now", "Preview", "Apply", "Discard"]);
  let applied = false;
  document.getElementById("apply")!.addEventListener("click", () => (applied = true));
  expect(clickButton("Apply").ok).toBe(true);
  expect(applied).toBe(true);
});

it("the bench never clicks Dictate or Continue, because either one opens the microphone", () => {
  expect(NEVER_CLICK.test("Dictate")).toBe(true);
  expect(NEVER_CLICK.test("Continue")).toBe(true);
  document.body.innerHTML = `<main><button>Dictate</button><button>Continue</button></main>`;
  expect(clickButton("Dictate").ok).toBe(false);
  expect(clickButton("Continue").ok).toBe(false);
});
