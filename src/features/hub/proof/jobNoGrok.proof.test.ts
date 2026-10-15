// Point 11 proof: a real job goes from start to Done through Ash OS's own job path with no Grok bot (and no model at
// all) involved. Runs the REAL ashos.Hub (exported read-only from exo-cc-studio HEAD) on a throwaway ledger.
// Opt-in, since it needs python3 and the exo-cc-studio checkout:  HUB_PROOF=1 npx vitest run src/features/hub/proof
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStubBridge } from "../../../dev/hubStubBridge";
import { mapJob } from "../model/hubStore";
import { workerOf } from "../model/liveJobs";
// @ts-expect-error plain .mjs helper
import { startIsolatedAshOs } from "../../../../scripts/proof/ashosIsolated.mjs";

const on = !!process.env.HUB_PROOF;
const log = (...a: unknown[]) => console.log("[proof-11]", ...a);

describe.skipIf(!on)("point 11: a job reaches Done with no Grok bot", () => {
  let svc: { base: string; token: string; ready: { ashos_head: string }; state(): Promise<{ models_called: number }>; stop(): Promise<void> };
  beforeAll(async () => {
    svc = await startIsolatedAshOs({ port: 18911, dev: true });
    log("Ash OS hub backend from exo-cc-studio", svc.ready.ashos_head, "on a throwaway ledger");
  }, 40_000);
  afterAll(async () => svc && svc.stop());

  it("the Lead starts, works, checks and finishes a job; the app sees it Done", async () => {
    const app = createStubBridge(svc.base, () => svc.token);
    // The Lead is a Claude Code session in Ash's app (ASH_MONO_ID / ASH_ROLE=lead), not a Grok bot.
    const lead = async (value: Record<string, unknown>) => {
      const r = await fetch(`${svc.base}/api/ash-hub-job`, {
        method: "POST", headers: { Authorization: `Bearer ${svc.token}` },
        body: JSON.stringify({ ...value, _caller: { mono_id: "proof-lead", role: "lead" } }),
      });
      const body = await r.json();
      if (!body.ok) throw new Error(body.error);
      return body.result;
    };

    await app.call("ash-hub-project-create", { name: "Proof Project", one_line: "proof", code: false });
    await app.call("ash-hub-mono-project-add", { mono_id: "proof-lead", project_id: "proof-project", role: "lead" });

    const started = await lead({ action: "start", project: "proof-project", title: "Write the proof file" });
    const id = started.job.id as string;
    log("start ->", started.job.state, id);
    expect(started.job.state).toBe("working");

    // The real work: write a file and check it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-11-"));
    const file = path.join(dir, "proof.txt");
    fs.writeFileSync(file, `job ${id} ran at ${new Date().toISOString()}\n`);
    await lead({ action: "step", job_id: id, note: "wrote proof.txt" });
    const checking = await lead({ action: "checking", job_id: id, note: "checking the file" });
    log("checking ->", checking.job?.state ?? checking.state);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    expect(fs.readFileSync(file, "utf8")).toContain(id);

    const done = await lead({ action: "done", job_id: id, evidence: `wrote ${file}; sha256 ${sha}; read back and contains the job id` });
    log("done ->", done.job?.state ?? done.state);

    // What the app reads: ash-hub-jobs through the app's own transport code, mapped to the Being built row.
    const listing = (await app.call("ash-hub-jobs", {})) as { groups: Array<Record<string, unknown> & { jobs: unknown[] }> };
    const group = listing.groups.find((g) => (g.jobs as Array<{ id: string }>).some((j) => j.id === id))!;
    const job = mapJob((group.jobs as Array<{ id: string }>).find((j) => j.id === id))!;
    log("app sees", job.state, "finishedAt", job.finishedAt);
    expect(job.state).toBe("done");
    expect(job.finishedAt).toBeTruthy();
    const row = workerOf(job, { projectId: job.projectId, leadId: "proof-lead", leadName: String(group.leadName ?? "Lead"), jobs: [] } as never, Date.now());
    expect(row.finishedAt).toBeTruthy();
    expect(row.stuck).toBeUndefined();

    const state = await svc.state();
    log("models_called =", state.models_called);
    expect(state.models_called).toBe(0);
  }, 30_000);
});
