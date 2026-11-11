import { expect, test } from "@playwright/test";
import fs from "node:fs";

const SHOTS = "docs/hivra/work/shots/wp-215/after";

test("the captain hands work on, answers from a standing answer, and passes one up", async ({ page }, testInfo) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/browser/wp215-captain.html");
  await expect(page.getByTestId("handoff")).toHaveText("Handed to Coding: Example: tighten the gate");
  await expect(page.getByTestId("standing-answer")).toHaveText("Example: keep it");
  await expect(page.getByTestId("standing-reason")).toHaveText("standing answer: merge on green");
  await expect(page.getByTestId("passup")).toHaveText("Chief of Staff suggests: Example: retry once");
  await expect(page.getByTestId("passup-reason")).toHaveText("it can wait");
  await expect(page.getByTestId("personality")).toHaveText("Warm and brief.");
  await expect(page.getByTestId("charter-kept")).toHaveText("The charter stays as it is.");
  await expect(page.locator("body")).not.toContainText("Crew");
  await expect(page.locator("body")).not.toContainText("—");
  await expect(page.locator("body")).not.toContainText("–");
  await page.screenshot({ path: `${SHOTS}/captain-${testInfo.project.name}.png`, fullPage: true });
});
