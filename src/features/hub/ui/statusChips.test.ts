// @vitest-environment happy-dom
// One state, one word, one chip (Critiquito, r27): Today showed "moving the nightly backup" and "tidying the sound files"
// as red "Stuck" right next to the red "Needs you" row, and Ash couldn't tell them apart. Their real Ash OS states:
// the backup is sent_to_lead (its Lead has it), the sound files are stuck (still retrying on their own). Red is now only
// for Needs you; the other two are grey chips, the same words on Today's rows, Today's Being built list and Being built.
import http from "node:http";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { HubSurface } from "./HubSurface";
import { BeingBuiltView } from "./BeingBuiltView";
import { setMonoChatOpener } from "../model/hubNav";

function httpTransport(baseUrl: () => string, token: () => string): HubTransport {
  return {
    call: (action, payload = {}) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request(
          `${baseUrl()}/api/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              const json = JSON.parse(raw);
              if (json.ok) resolve(json.result);
              else reject(new HubCallError("error", json.error));
            });
          },
        );
        req.on("error", () => reject(new HubCallError("unreachable", "Ash OS isn't running.")));
        req.end(body);
      }),
    openFeed: (_after, handlers) => {
      handlers.onState({ connected: false, message: "polling in this test" });
      return () => undefined;
    },
  };
}

let stub: Stub;
let store: HubStore;
let root: Root;
let container: HTMLElement;
async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => void (await new Promise((r) => setTimeout(r, 15))));
  }
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  stub = await startStub({ jobs: true });
  store = new HubStore({ transport: httpTransport(() => stub.url, () => stub.token), coalesceMs: 5, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
  await stub.close();
});


function mountAll() {
  act(() => root.render(createElement("div", null,
    createElement("div", { "data-today": "" }, createElement(HubSurface, { selection: { project: "today", item: "inbox" } })),
    createElement("div", { "data-built": "hivra" }, createElement(BeingBuiltView, { projectId: "hivra" })),
    createElement("div", { "data-built": "nibbii" }, createElement(BeingBuiltView, { projectId: "nibbii" })))));
}
/** The chip on Today's own row for a title (the Needs you / stuck rows, not the Being built list). */
function todayRowChip(title: string) {
  const today = container.querySelector("[data-today]")!;
  const rows = [...today.querySelectorAll<HTMLElement>("div")].filter(
    (d) => d.textContent?.startsWith(title) && !d.closest("[data-hub-today-job]") && d.querySelector("[data-hub-chip]"),
  );
  const row = rows.at(-1); // the innermost
  const chip = row?.querySelector<HTMLElement>("[data-hub-chip]");
  return chip ? { word: chip.textContent, tone: chip.dataset.hubCircle } : undefined;
}
function chipIn(sel: string) {
  const chip = container.querySelector<HTMLElement>(`${sel} [data-hub-chip]`);
  return chip ? { word: chip.textContent, tone: chip.dataset.hubCircle } : undefined;
}

it("the backup is With Hivra lead, the sound files Retrying, both grey; only the job Ash must act on is the red Needs you, on Today and Being built alike", async () => {
  mountAll();
  await until(
    () => todayRowChip("Example: tidying the sound files") && todayRowChip("Example: moving the nightly backup")
      && container.querySelector('[data-built="hivra"] [data-hub-worker="j_sender"]') && container.querySelector('[data-hub-today-job="j_sender"]'),
    "Today and Being built",
  );
  const withLead = { word: "With Hivra lead", tone: "grey" };
  const retrying = { word: "Retrying", tone: "grey" };
  const needsYou = { word: "Needs you", tone: "red" };

  // Today's rows.
  expect(todayRowChip("Example: moving the nightly backup")).toEqual(withLead);
  expect(todayRowChip("Example: tidying the sound files")).toEqual(retrying);
  expect([...container.querySelectorAll<HTMLElement>("[data-today] [data-hub-circle=red]")].map((c) => c.textContent)).toContain("Needs you");
  // Today's Being built list.
  expect(chipIn('[data-hub-today-job="j_backup"]')).toEqual(withLead);
  expect(chipIn('[data-hub-today-job="j_sender"]')).toEqual(needsYou);
  // Being built.
  expect(chipIn('[data-built="hivra"] [data-hub-worker="j_backup"]')).toEqual(withLead);
  expect(chipIn('[data-built="hivra"] [data-hub-worker="j_sender"]')).toEqual(needsYou);
  await until(() => container.querySelector('[data-built="nibbii"] [data-hub-worker="j_sound"]'), "nibbii's Being built");
  expect(chipIn('[data-built="nibbii"] [data-hub-worker="j_sound"]')).toEqual(retrying);

  // Red is only ever Needs you, and nothing on screen says "Stuck" in red.
  const reds = [...container.querySelectorAll<HTMLElement>("[data-hub-circle=red]")];
  expect(reds.length).toBeGreaterThan(0);
  for (const r of reds) expect(r.textContent || r.getAttribute("aria-label")).toBe("Needs you");
  expect(container.querySelectorAll(".text-red-400, .text-red-500")).toHaveLength(0);
});

// r27b: every red Needs you carries its reason and "Open <Lead>'s chat"; the backup's chip and the line under it name
// the same Lead, from the same place (the job's Lead in Ash OS's list), not "With Hivra lead" over "Sent to coding team lead".
it("every red Needs you shows why and opens its Lead's chat, and the backup names one Lead in its chip and its sent line", async () => {
  const opened: string[] = [];
  const undo = setMonoChatOpener((id) => opened.push(id));
  mountAll();
  await until(
    () => container.querySelector('[data-today] [data-hub-need="j:j_sender"] [data-hub-open-lead]')
      && container.querySelector('[data-hub-today-job="j_sender"] [data-hub-open-lead]')
      && container.querySelector('[data-built="hivra"] [data-hub-worker="j_sender"] [data-hub-open-lead]'),
    "the links",
  );
  const places = [
    '[data-today] [data-hub-need="j:j_sender"]',
    '[data-hub-today-job="j_sender"]',
    '[data-built="hivra"] [data-hub-worker="j_sender"]',
  ];
  for (const at of places) {
    const row = container.querySelector<HTMLElement>(at)!;
    expect(row.querySelector("[data-hub-circle=red]")?.textContent).toBe("Needs you");
    // The reason: Ash OS's own words for the row (the Need's why, or the job's reason).
    const why = row.querySelector("[data-hub-need-why], [data-hub-needs-reason], [data-hub-job-reason]")?.textContent ?? "";
    expect(why.length).toBeGreaterThan(10);
    const link = row.querySelector<HTMLButtonElement>("[data-hub-open-lead]")!;
    expect(link.textContent).toBe("Open Hivra lead's chat");
    act(() => link.click());
  }
  expect(opened).toEqual(["hivra-lead", "hivra-lead", "hivra-lead"]);
  // Every red chip on screen has its link next to it.
  const reds = [...container.querySelectorAll<HTMLElement>("[data-hub-circle=red]")];
  for (const r of reds) {
    const row = r.closest("[data-hub-need], [data-hub-today-job], [data-hub-worker]")!;
    expect(row.querySelector("[data-hub-open-lead]")).not.toBeNull();
  }
  // One Lead name on the backup row: the chip and the sent line, on Today and Being built.
  const todayBackup = [...container.querySelectorAll<HTMLElement>("[data-today] div")].filter(
    (d) => d.textContent?.startsWith("Example: moving the nightly backup") && d.querySelector("[data-hub-sent]") && d.querySelector("[data-hub-chip]"),
  ).at(-1)!;
  expect(todayBackup.querySelector("[data-hub-chip]")?.textContent).toBe("With Hivra lead");
  expect(todayBackup.querySelector("[data-hub-sent]")?.textContent).toMatch(/^Sent to Hivra lead at \d{1,2}:\d{2}[ap]m · Got it$/);
  const builtBackup = container.querySelector('[data-built="hivra"] [data-hub-worker="j_backup"]')!;
  expect(builtBackup.querySelector("[data-hub-chip]")?.textContent).toBe("With Hivra lead");
  expect(builtBackup.querySelector("[data-hub-job-sent]")?.textContent).toMatch(/^Sent to Hivra lead at .* · Got it$/);
  expect(todayBackup.textContent).not.toMatch(/coding team lead/i);
  expect(builtBackup.textContent).not.toMatch(/coding team lead/i);
  undo();
});

// r28 (PM's r44 check): "EXO · EXO lead · Needs you" said the project twice. A Lead named for its project stands alone.
it("Today's Being built rows don't repeat the project before a Lead named for it", async () => {
  mountAll();
  await until(() => container.querySelector('[data-hub-today-job="j_sender"] [data-hub-today-job-where]'), "Today's Being built");
  for (const id of ["j_sender", "j_backup", "j_mail"]) {
    const where = container.querySelector(`[data-hub-today-job="${id}"] [data-hub-today-job-where]`)!.textContent!;
    expect(where.startsWith("Hivra lead · ")).toBe(true);
    expect(where).not.toMatch(/^Hivra · /);
  }
});
