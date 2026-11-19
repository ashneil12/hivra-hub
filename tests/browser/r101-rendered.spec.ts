import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { EXAMPLE_PROJECTS, openLocalHub } from "./localHub";

// r101: a B5 run's saved end state (snapshot-end.json: the app's localStorage, roster and chats; evidence.json: what
// Ash sent the Lead and what it said) loaded into the real app in a browser, at Ash's window size in the dark glass
// theme. The Inbox, the Lead's chat and the rail, each RENDERED from the run, not live (never a shot of Ash's Mac).
//   R101_RUN=evidence/realtest/<run> R101_SCENARIO=b5-dump-restart-blind R101_OUT=evidence/r101/critiquito \
//   STUCK_PROOF_PORT=1561 PROOF_SPEC=r101-rendered.spec.ts npx playwright test -c tests/browser/stuck-workers.config.ts

const RUN = process.env.R101_RUN ?? "";
const SCENARIO = process.env.R101_SCENARIO ?? "b5-dump-restart-blind";
const OUT = process.env.R101_OUT ?? "test-results/r101-rendered";
// r103 (Critiquito a): shots are named for the round that rendered them (R101_ROUND, else the rN in R101_OUT).
const ROUND = process.env.R101_ROUND ?? /(r\d+)/.exec(OUT)?.[1] ?? "r101";
const W = 1512;
const H = 982;

type Snap = { storage: Record<string, string>; sessions: { id: string; cwd: string; title?: string; harness?: string; mono?: string }[] };
type Ev = { sends: { t: number; to?: { mono?: string }; text?: string }[]; texts: { t: number; session?: string; who?: string; text?: string }[] };

// r103 (Critiquito e): Ash's Retina window, so the rail's grey/red is judged at full size.
test.use({ deviceScaleFactor: 2 });
test.skip(!RUN, "R101_RUN names a realtest run folder");


test("Inbox, Lead chat and rail rendered from a B5 run's end state", async ({ page }) => {
  test.setTimeout(300_000);
  const dir = path.join(RUN, "scenarios", SCENARIO);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "snapshot-end.json"), "utf8")) as Snap;
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8")) as Ev;
  const lead = snap.sessions.find((s) => s.mono === "tally-lead")!;
  const id = path.basename(RUN).split("-").pop();
  const projects = [...EXAMPLE_PROJECTS, { id: "tally", name: "Tally", shortName: "Tally", iconShape: "chart", folder: lead.cwd }];
  // The Lead's chat as the run had it: Ash's messages to it and its own replies, in order.
  const blocks = [
    ...ev.sends.filter((s) => s.to?.mono === "tally-lead" && s.text).map((s) => ({ id: `u${s.t}`, role: "user", text: s.text, startedAt: s.t, t: s.t })),
    ...ev.texts.filter((x) => x.session === lead.id && x.text?.trim()).map((x) => ({ id: `a${x.t}`, role: "assistant", text: x.text, t: x.t })),
  ]
    .sort((a, b) => a.t - b.t)
    // The run logs a streamed reply as it grows, so drop a text that a later one of the same role repeats or extends.
    // and a turn's closing result repeats its last text, so drop a text another nearby one of the same role holds.
    .filter((b, i, all) =>
      !all.some((o, j) => j !== i && o.role === b.role && Math.abs(o.t - b.t) < 120_000 && (o.text.length > b.text.length ? o.text.includes(b.text) : o.text === b.text && j > i)),
    )
    .map(({ t: _t, ...b }) => b);
  // r103 (Critiquito f): a session with no title (the snapshot only names its harness, "claude") that no Mono owns was the app's empty new-chat placeholder; it showed
  // as a bare "New session" row under Older, which the run never made for Ash, so it is not seeded.
  const sessions = snap.sessions.filter((s) => s.title?.replace(/^(?:claude|codex|grok)\b\s*(?:·\s*)?/i, "").trim() || s.mono || s.id === lead.id).map((s) => ({ id: s.id, cwd: s.cwd, title: s.title ?? "", harness: s.harness ?? "claude", ...(s.id === lead.id ? { blocks } : {}) }));
  const storage = { ...snap.storage };
  delete storage["monocode:hub-nav"];
  await page.addInitScript(
    ({ storage, sessions, roster }) => {
      // The dev mock answers session_get from the seeded chats but not mono_session_get, so the Lead's chat (a Mono
      // session) is read through session_get here; test-only, nothing in src changes.
      const internals = ((window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ ??= {});
      let real: ((cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>) | undefined;
      Object.defineProperty(internals, "invoke", {
        configurable: true,
        get: () => (cmd: string, args?: unknown, opts?: unknown) =>
          // The DeepSeek launcher hides the Claude usage chip, so no sample numbers reach a rendered shot.
          cmd === "harness_runtime_binary_paths"
            ? Promise.resolve({ ...((args as { paths?: object } | undefined)?.paths ?? {}), claude: "/Users/ash/.local/bin/claude-deepseek" })
            : real!(cmd === "mono_session_get" ? "session_get" : cmd, args, opts),
        set: (fn) => (real = fn),
      });
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
      localStorage.setItem("monocode:dev-roster-seed", roster);
      localStorage.setItem("monocode:dev-sessions", JSON.stringify(sessions));
      localStorage.setItem("monocode.colorScheme", "dark");
      localStorage.setItem("monocode.insetLayout", "1");
      localStorage.setItem("monocode.insetGlass", "1");
      localStorage.setItem("monocode.bodyGlass", "1");
    },
    { storage, sessions, roster: storage["monocode:mono-roster"] ?? "[]" },
  );
  await page.setViewportSize({ width: W, height: H });
  await openLocalHub(page, "", projects);
  await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: /^Tally/ }).first().click();
  fs.mkdirSync(OUT, { recursive: true });
  const name = (view: string) => path.join(OUT, `${ROUND}-${id}-${view}-RENDERED-from-run-not-live.png`);
  const label = async (view: string) =>
    page.evaluate((text) => {
      document.querySelector("[data-r101-label]")?.remove();
      const tag = document.createElement("div");
      tag.setAttribute("data-r101-label", "");
      tag.textContent = text;
      Object.assign(tag.style, { position: "fixed", right: "8px", bottom: "8px", zIndex: "99999", background: "#b91c1c", color: "white", font: "600 12px system-ui", padding: "4px 8px", borderRadius: "6px", pointerEvents: "none" });
      document.body.appendChild(tag);
    }, `RENDERED from run ${id}, not live: ${view}`);
  const settle = async () => {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
  };

  await page.getByRole("complementary").first().getByRole("button", { name: /^Needs you/ }).first().click();
  await page.waitForTimeout(2500);
  await label("Inbox");
  await settle();
  // No sample usage in a rendered shot: on the DeepSeek launcher the Claude chip is hidden.
  await expect(page.locator("[data-usage-window]")).toHaveCount(0);
  await page.screenshot({ path: name("inbox") });
  const rail = page.getByRole("complementary").first();
  await label("rail");
  await rail.screenshot({ path: name("rail") });
  // r103 (Critiquito e): an unread count is grey; only a Needs you is red. No red-tinted unread chip on the rail.
  const unreadColours = await rail.locator("[data-mono-unread]").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  console.log(`${ROUND} rendered ${id}: rail unread chip colours: ${unreadColours.join(" | ") || "none"}`);
  for (const colour of unreadColours) {
    const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).map(Number);
    expect(r - Math.max(g, b), `unread chip ${colour} is red-tinted`).toBeLessThan(40);
  }
  await expect(rail.getByText(/^New session$/)).toHaveCount(0);
  console.log(`${ROUND} rendered ${id}: inbox text: ${(await page.getByRole("region", { name: "Inbox" }).first().innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`);
  console.log(`${ROUND} rendered ${id}: rail text: ${(await rail.innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 400)}`);

  const open = page.getByRole("button", { name: /Tally lead/i }).first();
  if (await open.isVisible().catch(() => false)) await open.click();
  else console.log(`${ROUND} rendered ${id}: no "Tally lead" button; buttons: ${(await page.getByRole("complementary").first().innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 400)}`);
  await page.waitForTimeout(2500);
  await label("Lead chat");
  await settle();
  await page.screenshot({ path: name("lead-chat") });
  console.log(`${ROUND} rendered ${id}: chat text tail: ${(await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ").slice(-600)}`);
});
