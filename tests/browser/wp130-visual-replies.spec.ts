import { expect, test } from "@playwright/test";

test("a visual reply cannot reach the parent page or the network", async ({ page }) => {
  const finished: string[] = [];
  page.on("request", (req) => {
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

  const leaked = notes.filter(
    (note) =>
      note.includes("hivra-visual-nav") &&
      !/refused|frame-src|blocked form|violates the following/i.test(note),
  );
  expect(leaked).toEqual([]);
  expect(notes.some((note) => /refused|frame-src|blocked form/i.test(note) && note.includes("1473"))).toBe(
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
