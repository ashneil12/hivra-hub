import { expect, test } from "@playwright/test";

const CHAT = "11111111-1111-4111-8111-111111111111";
const CHAT_LINK = `hivra://local/chat/${CHAT}`;
const MISSING = "This chat is not on this computer.";
const OFF = "This link is not for this computer.";
const PUBLIC = "This app does not open public links.";

test("a local link copies, fills the prompt, and a missing chat stays on this page", async ({
  page,
}) => {
  await page.goto("/tests/browser/wp125-thread-links.html");

  await expect(page.getByRole("heading", { name: "Demo chat" })).toBeVisible();
  const chatButton = page.locator("[data-thread-link='chat']");
  await expect(chatButton).toHaveText("Copy chat link");
  await expect(chatButton).toHaveAttribute("data-link", CHAT_LINK);

  const promptButton = page.locator("[data-thread-link='prompt']");
  await expect(promptButton).toHaveText("Copy prompt link");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.fill("Ship the notes");
  await promptButton.click();
  await expect(promptButton).toHaveText("Copied");
  await expect(promptButton).toHaveAttribute(
    "data-link",
    "hivra://local/prompt/demo?text=Ship%20the%20notes",
  );

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("hivra:open-thread-link", {
        detail: "hivra://local/chat/22222222-2222-4222-8222-222222222222",
      }),
    );
  });
  await expect(page.locator("[data-thread-link-notice]")).toContainText(MISSING);
  await expect(page.getByRole("heading", { name: "Demo chat" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(page.url()).toContain("wp125-thread-links.html");

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("hivra:open-thread-link", {
        detail: "https://example.com/guest?sig=1",
      }),
    );
  });
  await expect(page.locator("[data-thread-link-notice]")).toContainText(OFF);
  expect(page.url()).toContain("wp125-thread-links.html");
  expect(page.url()).not.toContain("example.com");

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("hivra:open-thread-link", {
        detail: "hivra://local/guest/hello",
      }),
    );
  });
  await expect(page.locator("[data-thread-link-notice]")).toContainText(PUBLIC);

  const stopped = await page.evaluate(() => {
    const anchor = document.querySelector("a[href^='hivra:']");
    if (!anchor) return "missing";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    return event.defaultPrevented ? "stopped" : "navigated";
  });
  expect(stopped).toBe("stopped");
  await expect(page.locator("[data-thread-link-notice]")).toContainText(MISSING);
  expect(page.url()).toContain("wp125-thread-links.html");

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("hivra:open-thread-link", {
        detail: "hivra://local/prompt/demo?text=Open%20the%20notes",
      }),
    );
  });
  await expect(prompt).toHaveValue("Open the notes");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
  expect(text.toLowerCase()).not.toContain("http");
});
