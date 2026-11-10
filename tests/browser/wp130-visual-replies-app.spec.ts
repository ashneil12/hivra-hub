import { expect, test, type Page } from "@playwright/test";
import { visualFrameCsp } from "../../src/features/sessions/model/visualReply";

// WP-130 under the app's own policy. The page stands in for the app window (its CSP, Tauri's globals with a secret,
// a theme), and this spec serves the app's frame scheme with the policy src-tauri/src/page_frames.rs serves (a unit
// test keeps the two strings equal). Every local and remote target the probe tries is answered with 200 by this spec,
// so a target the policy let through shows up as "open" and in `reached`: a failure is the policy, not a dead host.

type Probe = {
  label: string;
  ran?: boolean;
  done?: boolean;
  tauri?: string;
  popup?: string;
  origin?: string;
  bg?: string;
  color?: string;
  font?: string;
  violations: string[];
  loads: Record<string, string>;
  [field: string]: unknown;
};

const BLOCKED_FIELDS = ["parentTauri", "topTauri", "topSecret", "topTitle", "parentTitle", "storage"];
const NO_TAURI = "undefined/undefined/undefined/undefined";

async function serveFrameSchemeAndTargets(page: Page) {
  const served: string[] = [];
  const reached: string[] = [];
  await page.route("http://monoartifact.localhost/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/page-")) {
      reached.push(url.href);
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "x" });
    }
    const key = url.pathname.replace(/^\/page-/, "");
    const entry = await page.evaluate((k) => window.__visualFrames?.[k], key);
    if (!entry) return route.fulfill({ status: 404, body: "" });
    served.push(key);
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": visualFrameCsp(entry.network),
        "x-content-type-options": "nosniff",
      },
      body: entry.html,
    });
  });
  const answer = async (route: import("@playwright/test").Route) => {
    reached.push(route.request().url());
    await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "x" });
  };
  await page.route(/hivra-visual-(local|relative|popup|topnav|remote)/, answer);
  await page.route(/^https?:\/\/(asset|ipc)\.localhost\//, answer);
  return { served, reached };
}

async function probes(page: Page): Promise<Record<string, Probe>> {
  return JSON.parse((await page.locator("[data-probes]").getAttribute("data-probes")) ?? "{}");
}

async function waitDone(page: Page, label: string): Promise<Probe> {
  await expect
    .poll(async () => Boolean((await probes(page))[label]?.done), { timeout: 20000 })
    .toBe(true);
  return (await probes(page))[label];
}

function expectShut(probe: Probe) {
  expect(probe.ran).toBe(true);
  expect(probe.tauri).toBe(NO_TAURI);
  for (const field of BLOCKED_FIELDS) expect(probe[field], field).toBe("blocked");
  // Chromium throws on an opaque origin's cookie; WebKit returns nothing. Either way not the app's cookie.
  expect(["blocked", ""]).toContain(probe.cookie);
  expect(probe.popup).toBe("none");
  expect(probe.origin).toBe("null");
}

test("in the app a visual reply runs in its served frame, sees no Tauri or page, and reads no file or network", async ({ page }) => {
  const { served, reached } = await serveFrameSchemeAndTargets(page);
  await page.goto("/tests/browser/wp130-visual-replies-app.html");
  const probe = await waitDone(page, "served");
  expect(served.some((key) => key.startsWith("visual-"))).toBe(true);
  expectShut(probe);
  expect(Object.keys(probe.loads).length).toBe(22);
  for (const [target, result] of Object.entries(probe.loads)) expect(result, target).toBe("failed");
  // The theme reached the frame: background, text and font.
  expect(probe.bg).toBe("rgb(18, 52, 86)");
  expect(probe.color).toBe("rgb(171, 205, 239)");
  expect(probe.font).toContain("Theme Sans");
  // The page is untouched, no target was reached, and the shell passed on nothing but a height.
  await expect(page).toHaveTitle("Hivra app");
  expect(page.url()).toContain("wp130-visual-replies-app.html");
  expect(reached).toEqual([]);
  await expect(page.locator("[data-probes]")).toHaveAttribute("data-forwarded", "0");
});

test("in the app a srcdoc frame would inherit the app policy and the reply's script would never run", async ({ page }) => {
  await serveFrameSchemeAndTargets(page);
  await page.goto("/tests/browser/wp130-visual-replies-app.html");
  await waitDone(page, "served");
  expect((await probes(page)).srcdoc).toBeUndefined();
});

test("opting in lets a reply reach https only: never this machine, its local files or the app's schemes", async ({ page }) => {
  const { reached } = await serveFrameSchemeAndTargets(page);
  await page.goto("/tests/browser/wp130-visual-replies-app.html");
  const box = page.locator("[data-reply='net']");
  await waitDone(page, "net");
  expect(reached).toEqual([]);
  await page.evaluate(() => window.__forgetProbe?.("net"));
  await box.getByRole("button", { name: "Allow network" }).click();
  await expect(box.getByRole("button", { name: "Allow network" })).toHaveAttribute("aria-pressed", "true");
  const net = await waitDone(page, "net");
  expectShut(net);
  // Allowed: a remote https target (answered by this spec). On Windows the app's asset scheme can be
  // https://asset.localhost, which an https policy cannot name apart; the asset scheme answers only the app's own
  // origin, so a reply cannot read it (see the WP doc).
  expect(net.loads["fetch https://example.invalid/hivra-visual-remote"]).toBe("open");
  for (const [target, result] of Object.entries(net.loads)) {
    if (target.endsWith("https://example.invalid/hivra-visual-remote") || target.includes("https://asset.localhost"))
      continue;
    expect(result, target).toBe("failed");
  }
  expect(net.violations.some((uri) => uri.includes("127.0.0.1"))).toBe(true);
  expect(
    reached.filter((url) => !url.startsWith("https://example.invalid/") && !url.startsWith("https://asset.localhost/")),
  ).toEqual([]);
  await expect(page).toHaveTitle("Hivra app");
});
