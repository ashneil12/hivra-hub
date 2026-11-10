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

// The probe's targets (keep in step with tests/browser/wp130-visual-replies-app.tsx): each is tried by fetch and img.
const TARGETS = 13;
const LOADS = TARGETS * 2;
const BLOCKED_FIELDS = ["parentTauri", "topTauri", "topSecret", "topTitle", "parentTitle", "storage"];
const NO_TAURI = "undefined/undefined/undefined/undefined";
const REMOTE = "https://example.invalid/hivra-visual-remote";
// Known limit (see the WP doc): with the network on, `https:` also names this machine and the local network. The
// policy cannot tell them apart, so these open. A proxy that refuses private addresses would flip this on purpose.
const KNOWN_OPEN_WITH_NETWORK = [
  "https://127.0.0.1/hivra-visual-local",
  "https://localhost/hivra-visual-local",
];

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
  await page.route(/^https:\/\/(127\.0\.0\.1|localhost)\//, answer);
  return { served, reached };
}

async function probes(page: Page): Promise<Record<string, Probe>> {
  return JSON.parse((await page.locator("[data-probes]").getAttribute("data-probes")) ?? "{}");
}

/** Waits until the probe has settled every one of its loads (a count, not a timer). */
async function waitDone(page: Page, label: string): Promise<Probe> {
  await expect
    .poll(async () => {
      const probe = (await probes(page))[label];
      return Boolean(probe?.done) && Object.keys(probe?.loads ?? {}).length === LOADS;
    }, { timeout: 30000 })
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
  expect(Object.keys(probe.loads).length).toBe(LOADS);
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
  // The srcdoc box runs under the same page, so a probe there would show up if its script ran at all.
  await expect(page.locator("[data-reply='srcdoc'] iframe")).toHaveCount(1);
  expect((await probes(page)).srcdoc).toBeUndefined();
});

test("opting in lets a reply reach https only: never plain http, the app's schemes, files or Tauri, and the known https limit", async ({ page }) => {
  const { reached } = await serveFrameSchemeAndTargets(page);
  await page.goto("/tests/browser/wp130-visual-replies-app.html");
  const box = page.locator("[data-reply='net']");
  await waitDone(page, "net");
  expect(reached).toEqual([]);
  await page.evaluate(() => window.__forgetProbe?.("net"));
  await box.getByRole("button", { name: "Allow network" }).click();
  await expect(box.getByRole("button", { name: "Allow network" })).toHaveAttribute("aria-pressed", "true");
  // The visible warning: the person sees that the network is on and what it reaches.
  await expect(box.getByRole("note")).toContainText("Network on");
  await expect(box.getByRole("note")).toContainText("this machine");
  const net = await waitDone(page, "net");
  expectShut(net);
  // Allowed: a remote https host. The asset scheme (https://asset.localhost on Windows) is not named apart by https.
  expect(net.loads[`fetch ${REMOTE}`]).toBe("open");
  // The known limit: https to this machine opens with the network on. Only fetch is read: the spec answers img with text.
  for (const target of KNOWN_OPEN_WITH_NETWORK) expect(net.loads[`fetch ${target}`], target).toBe("open");
  for (const [target, result] of Object.entries(net.loads)) {
    if (target.endsWith(REMOTE) || target.includes("https://asset.localhost")) continue;
    if (KNOWN_OPEN_WITH_NETWORK.some((known) => target.endsWith(known)) && target.startsWith("fetch ")) continue;
    expect(result, target).toBe("failed");
  }
  expect(net.violations.some((uri) => uri.includes("127.0.0.1"))).toBe(true);
  expect(
    reached.filter(
      (url) =>
        !url.startsWith("https://example.invalid/") &&
        !url.startsWith("https://asset.localhost/") &&
        !url.startsWith("https://127.0.0.1/") &&
        !url.startsWith("https://localhost/"),
    ),
  ).toEqual([]);
  await expect(page).toHaveTitle("Hivra app");
});

test("a reply loaded from history waits for a click, and a frame that never loads shows its source", async ({ page }) => {
  const { reached } = await serveFrameSchemeAndTargets(page);
  await page.goto("/tests/browser/wp130-visual-replies-app.html");
  const restored = page.locator("[data-reply='restored']");
  await expect(restored.getByRole("button", { name: "Run visual reply" })).toBeVisible();
  await expect(restored.locator("iframe")).toHaveCount(0);
  expect((await probes(page)).restored).toBeUndefined();
  await restored.getByRole("button", { name: "Run visual reply" }).click();
  await expect(restored.locator("iframe[data-visual-reply-src]")).toHaveCount(1);
  await waitDone(page, "restored");
  expect(reached).toEqual([]);

  // The scheme holds no document for this key, so the shell never says it loaded: the source shows instead.
  const missing = page.locator("[data-reply='missing']");
  await expect(missing.getByText("This reply could not be shown here.")).toBeVisible({ timeout: 20000 });
  await expect(missing.locator("pre")).toContainText("the source stays");
});
