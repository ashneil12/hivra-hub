import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("a visual reply cannot reach the parent page or the network", async ({ page }) => {
  // Chromium raises "request" for a load the policy then blocks (and "requestfailed" with "csp"), so only a load that
  // finished counts. example.invalid answers 200 here, so a probe reading "blocked" means the policy stopped it, not
  // that the name doesn't resolve, and a load that got past the policy reaches the route and is caught.
  const finished: string[] = [];
  const reached: string[] = [];
  await page.route("https://example.invalid/**", (route) => {
    reached.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", body: "reached" });
  });
  page.on("requestfinished", (req) => {
    if (req.url().includes("hivra-visual-nav") || req.url().includes("example.invalid")) {
      finished.push(req.url());
    }
  });
  const notes: string[] = [];
  page.on("console", (msg) => notes.push(msg.text()));
  page.on("pageerror", (err) => notes.push(String(err)));
  await page.goto("/tests/browser/wp130-visual-replies.html");
  const probeNode = page.locator("[data-probe]");
  try {
    await expect(probeNode).toHaveAttribute("data-probe", /"late":true/, { timeout: 8000 });
    await expect(probeNode).toHaveAttribute("data-probe", /"net":"blocked"/);
    await expect(probeNode).toHaveAttribute("data-probe", /"img":"blocked"/);
    await expect(probeNode).toHaveAttribute("data-probe", /"dataImg":"shown"/);
    await expect(probeNode).toHaveAttribute("data-probe", /"dom":false/);
    await expect(page.locator("[data-nav]")).toHaveAttribute("data-nav", /"step":"(after|late)"/);
    await expect(page.locator("[data-meta]")).toHaveAttribute("data-meta", /"step":"(ready|late)"/);
    await expect(page.locator("[data-form]")).toHaveAttribute("data-form", /"step":"late"/);
  } catch (error) {
    const frame = page.locator("[data-visual-reply='probe']");
    const state = await frame
      .evaluate((node: HTMLIFrameElement) => ({
        sandbox: node.getAttribute("sandbox"),
        src: node.getAttribute("src"),
        srcdocLength: (node.getAttribute("srcdoc") ?? "").length,
      }))
      .catch((err: unknown) => String(err));
    throw new Error(
      `${String(error)}\nprobe=${await probeNode.getAttribute("data-probe")}\nnav=${await page.locator("[data-nav]").getAttribute("data-nav")}\nmeta=${await page.locator("[data-meta]").getAttribute("data-meta")}\nform=${await page.locator("[data-form]").getAttribute("data-form")}\nframe=${JSON.stringify(state)}\nnotes=${notes.join(" | ")}`,
    );
  }

  const raw = await probeNode.getAttribute("data-probe");
  const probe = JSON.parse(raw ?? "{}") as { dom: boolean; net: string; img: string };
  expect(probe.dom).toBe(false);
  expect(probe.net).toBe("blocked");
  expect(probe.img).toBe("blocked");
  await expect(page).toHaveTitle("Hivra visual");
  expect(finished).toEqual([]);
  expect(reached).toEqual([]);

  const leaked = notes.filter(
    (note) =>
      note.includes("hivra-visual-nav") &&
      !/refused|frame-src|blocked form|violates the following/i.test(note),
  );
  expect(leaked).toEqual([]);
  expect(notes.some((note) => /refused|frame-src|blocked form/i.test(note) && note.includes(new URL(page.url()).port))).toBe(
    true,
  );
  expect(notes.some((note) => note.includes("@vite/client") && note.includes("origin 'null'"))).toBe(
    false,
  );
  const nav = JSON.parse((await page.locator("[data-nav]").getAttribute("data-nav")) ?? "{}") as {
    step?: string;
    href?: string;
  };
  if (nav.step === "late") expect(nav.href ?? "").not.toContain("hivra-visual-nav");
  expect(nav.step === "late" || nav.step === "after").toBe(true);

  for (const label of ["probe", "breakout", "nav", "meta", "form"]) {
    const frame = page.locator(`[data-visual-reply="${label}"]`);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const access = await frame.evaluate((node: HTMLIFrameElement) => {
      try {
        return node.contentDocument ? "open" : "null";
      } catch {
        return "throw";
      }
    });
    expect(access).toBe("null");
    const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).not.toContain("allow-same-origin");
    expect(srcdoc).toContain('sandbox="allow-scripts"');
  }
  const probeSrc = (await page.locator("[data-visual-reply='probe']").getAttribute("srcdoc")) ?? "";
  expect(probeSrc.indexOf("connect-src 'none'")).toBeLessThan(probeSrc.indexOf("parent.document.title"));
  const breakoutSrc = (await page.locator("[data-visual-reply='breakout']").getAttribute("srcdoc")) ?? "";
  expect(breakoutSrc.indexOf("connect-src 'none'")).toBeLessThan(
    breakoutSrc.indexOf("parent.document.title"),
  );
});

test("a visual reply takes the page background, text and fonts", async ({ page }) => {
  await page.goto("/tests/browser/wp130-visual-replies.html");
  await page.evaluate(() => {
    const root = document.documentElement;
    root.classList.add("theme-light");
    root.style.setProperty("--color-background-base", "#123456");
    root.style.setProperty("--color-content", "#abcdef");
    root.style.setProperty("--font-sans", "Theme Sans");
    root.style.setProperty("--font-mono", "Theme Mono");
  });
  const frame = page.locator("[data-themed-reply] iframe");
  await expect(frame).toHaveAttribute("srcdoc", /--hivra-background:rgb\(18,\s*52,\s*86\)/);
  await expect(frame).toHaveAttribute("srcdoc", /--hivra-text:rgb\(171,\s*205,\s*239\)/);
  await expect(frame).toHaveAttribute("srcdoc", /--hivra-font:Theme Sans/);
  await expect(frame).toHaveAttribute("srcdoc", /--hivra-mono:Theme Mono/);
  await expect(frame).toHaveAttribute("srcdoc", /color-scheme:light/);
  const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
  const tokens = srcdoc.indexOf("--hivra-background:");
  const own = srcdoc.indexOf(">chart</p>");
  expect(tokens).toBeGreaterThan(-1);
  expect(own).toBeGreaterThan(tokens);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
});

test("a visual reply can be saved, shown as source, or allowed onto the network", async ({ page }) => {
  await page.goto("/tests/browser/wp130-visual-replies.html");
  const box = page.locator("[data-themed-reply]");
  const frame = box.locator("iframe");
  await expect(frame).toHaveAttribute("srcdoc", /connect-src 'none'/);

  await box.getByRole("button", { name: "Allow network" }).click();
  await expect(box.getByRole("button", { name: "Allow network" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(frame).not.toHaveAttribute("srcdoc", /connect-src 'none'/);
  const open = (await frame.getAttribute("srcdoc")) ?? "";
  expect(open).toContain("connect-src https:");
  expect(open).not.toMatch(/script-src[^;]*https:/);
  expect(open).toContain("frame-src 'none'");

  await box.getByRole("button", { name: "Allow network" }).click();
  await expect(box.getByRole("button", { name: "Allow network" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(frame).toHaveAttribute("srcdoc", /connect-src 'none'/);

  await box.getByRole("button", { name: "Show source" }).click();
  await expect(box.locator("iframe")).toHaveCount(0);
  await expect(box.locator("pre")).toHaveText('<p id="themed">chart</p>');

  await box.getByRole("button", { name: "Show visual" }).click();
  await expect(box.locator("iframe")).toHaveCount(1);
  await expect(box.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    box.getByRole("button", { name: "Save as file" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("visual-reply.html");
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();
  expect(await readFile(savedPath!, "utf8")).toBe('<p id="themed">chart</p>');
  await expect(page).toHaveTitle("Hivra visual");
  expect(page.url()).not.toContain("blob:");
});
