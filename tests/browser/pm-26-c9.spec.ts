import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 26 proof, C9 (the real app in a browser, hub-dev.html reading the stub Ash OS; not Ash's Mac; made-up data
// labelled Example:): a project's own Today (G1: a project is the unit of the hub, its Inbox is its Today) opens with
// the "Since …" paragraph to glance at, above the Needs you and Being built sections, with the detail below to scroll
// to; Ash OS's standing reminder and PR list are left out of it.
//   PM_PROOF_SPEC=pm-26-c9.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-26";
type Stub = { url: string; close(): Promise<void>; setSince(overall: string, projects: Record<string, string>): void };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
  // A project's Today asks for its own Since paragraph: give EXO's (the stub's first project, which a fresh load opens).
  stub.setSince(
    "",
    {
      "vg-game":
        "Example: EXO's new level is in and the playtest build is up. 102 things are waiting on you. Merged PRs: #412, #415 and #418. " +
        "Hivra's waitlist email went out to 40 people, and Alfred tidied the team notes.",
    },
  );
});
test.afterAll(async () => stub?.close());

test("C9: the Since paragraph is the glance at the top of Today, detail below", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const since = page.locator("[data-hub-since]");
  await expect(since).toContainText("Example: EXO's new level", { timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 3000 }).then(() => notNow.click(), () => undefined);
  const text = (await since.textContent())!;
  console.log(`pm-26 since: ${text}`);
  expect(text).not.toMatch(/waiting on you|PRs?\b|#\d+/);
  // First thing in the project's Today body, above its Needs you and Being built sections.
  const order = await page.$eval("[data-hub-surface-body]", (body) =>
    [...body.children].map(
      (el) =>
        el.getAttribute("data-hub-today-section") ??
        (el.hasAttribute("data-hub-ship")
          ? "ship"
          : el.hasAttribute("data-hub-stuck-today")
            ? `stuck:${el.getAttribute("data-hub-stuck-today")}`
            : el.hasAttribute("data-hub-waiting")
              ? "waiting"
              : el.hasAttribute("data-hub-today-setup")
                ? "setup"
                : el.tagName),
    ),
  );
  console.log(`pm-26 order: ${order.join(" > ")}`);
  expect(order[0]).toBe("since");
  const box = (await since.boundingBox())!;
  expect(box.y).toBeLessThan(260); // a glance: on screen without scrolling
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/pm-26-c9-today-top-1512.png` });
  // The detail is below, to scroll to.
  await page.locator('[data-hub-today-section="needs"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-26-c9-today-detail-1512.png` });
});
