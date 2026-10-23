// @vitest-environment happy-dom
// H7: the four things a first launch has to reach are checked for real, written down when they pass, and never asked
// about again. A failed check is shown but never erases what was proved before.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkHubSetup,
  chosenSetupFolder,
  recordedSetupChecks,
  recordSetupFact,
  setupProved,
  type SetupProbes,
} from "./setupProof";

afterEach(() => localStorage.clear());

const allPass: SetupProbes = {
  installed: async () => ({ ok: true, detail: "1.2.3 at /usr/local/bin/claude" }),
  signedIn: async () => ({ ok: true, detail: "Signed in as ash@example.com." }),
  folder: async (path) => ({ ok: true, detail: path }),
  roundTrip: async () => ({ ok: true, detail: "Answered in 1.2 s." }),
};

const proveAll = () => {
  recordSetupFact("installed", "1.2.3");
  recordSetupFact("signedIn", "Signed in.");
  recordSetupFact("folder", "/work");
  recordSetupFact("roundTrip", "Answered.");
};

describe("what has been proved", () => {
  it("is proved only once all four checks have passed", () => {
    expect(setupProved()).toBe(false);
    recordSetupFact("installed", "1.2.3");
    recordSetupFact("signedIn", "Signed in.");
    recordSetupFact("folder", "/work");
    expect(setupProved()).toBe(false);
    recordSetupFact("roundTrip", "Answered.");
    expect(setupProved()).toBe(true);
  });

  it("survives a broken record instead of throwing or pretending", () => {
    localStorage.setItem("monocode:hub-setup-proof", "{not json");
    expect(setupProved()).toBe(false);
    expect(recordedSetupChecks().every((check) => check.state === "checking")).toBe(true);
    localStorage.setItem("monocode:hub-setup-proof", JSON.stringify({ version: 99, facts: {} }));
    expect(setupProved()).toBe(false);
  });

  it("shows what it already knows before anything is checked", () => {
    recordSetupFact("installed", "1.2.3 at /usr/local/bin/claude");
    expect(recordedSetupChecks()).toEqual([
      { id: "installed", state: "proved", detail: "1.2.3 at /usr/local/bin/claude" },
      { id: "signedIn", state: "checking", detail: "" },
      { id: "folder", state: "checking", detail: "" },
      { id: "roundTrip", state: "checking", detail: "" },
    ]);
  });
});

describe("checking setup", () => {
  it("runs the four checks in order, reports each one as it lands, and proves the install", async () => {
    const seen: string[][] = [];
    const run = await checkHubSetup({
      folder: "/work",
      probes: allPass,
      onCheck: (checks) => seen.push(checks.map((check) => `${check.id}:${check.state}`)),
    });
    expect(run.proved).toBe(true);
    expect(run.checks.map((check) => check.state)).toEqual(["proved", "proved", "proved", "proved"]);
    expect(seen[seen.length - 1]).toEqual(["installed:proved", "signedIn:proved", "folder:proved", "roundTrip:proved"]);
    expect(setupProved()).toBe(true);
    expect(chosenSetupFolder()).toBe("/work");
  });

  it("does not run the checks again once they are proved", async () => {
    proveAll();
    const probes = {
      installed: vi.fn(allPass.installed),
      signedIn: vi.fn(allPass.signedIn),
      folder: vi.fn(allPass.folder),
      roundTrip: vi.fn(allPass.roundTrip),
    };
    const run = await checkHubSetup({ folder: "/work", probes });
    expect(run.proved).toBe(true);
    expect(probes.installed).not.toHaveBeenCalled();
    expect(probes.roundTrip).not.toHaveBeenCalled();
  });

  it("checks everything again when asked, and a failure is shown without erasing the proof", async () => {
    proveAll();
    const run = await checkHubSetup({
      folder: "/work",
      refresh: true,
      probes: { ...allPass, installed: async () => ({ ok: false, detail: "Claude Code not found." }) },
    });
    expect(run.proved).toBe(false);
    expect(run.checks.find((check) => check.id === "installed")).toMatchObject({ state: "missing", detail: "Claude Code not found." });
    // What was true when it was checked stays true, so the card does not nag on the next launch.
    expect(setupProved()).toBe(true);
  });

  it("takes the first folder that passes, from the picked one, the remembered one or a project's", async () => {
    localStorage.setItem("monocode:hub-setup-folder", "/remembered");
    const tried: string[] = [];
    const run = await checkHubSetup({
      folder: "/picked",
      knownFolders: [null, "/project-a", "/project-b"],
      probes: {
        ...allPass,
        folder: async (path) => {
          tried.push(path);
          return path === "/project-a" ? { ok: true, detail: path } : { ok: false, detail: `${path} is gone.` };
        },
      },
    });
    expect(tried).toEqual(["/picked", "/remembered", "/project-a"]);
    expect(run.proved).toBe(true);
    expect(chosenSetupFolder()).toBe("/project-a");
  });

  it("says a folder is needed when there is none, and does not send a test message without one", async () => {
    const roundTrip = vi.fn(allPass.roundTrip);
    const run = await checkHubSetup({ probes: { ...allPass, roundTrip } });
    expect(run.proved).toBe(false);
    expect(run.checks.find((check) => check.id === "folder")?.state).toBe("missing");
    expect(run.checks.find((check) => check.id === "roundTrip")?.detail).toBe("Needs a folder first.");
    expect(roundTrip).not.toHaveBeenCalled();
  });

  it("does not send a test message without a working CLI", async () => {
    const roundTrip = vi.fn(allPass.roundTrip);
    const run = await checkHubSetup({
      folder: "/work",
      probes: { ...allPass, installed: async () => ({ ok: false, detail: "Not installed." }), roundTrip },
    });
    expect(run.checks.find((check) => check.id === "roundTrip")?.detail).toBe("Needs Claude Code first.");
    expect(roundTrip).not.toHaveBeenCalled();
  });

  it("counts an answer as proof of sign-in when no account name could be read", async () => {
    const run = await checkHubSetup({
      folder: "/work",
      probes: {
        ...allPass,
        signedIn: async () => ({ ok: false, detail: "No Claude Code account is signed in on this Mac yet." }),
      },
    });
    expect(run.proved).toBe(true);
    expect(run.checks.find((check) => check.id === "signedIn")).toMatchObject({
      state: "proved",
      detail: "The test message was answered, so Claude Code is signed in.",
    });
  });

  it("stops when the card closes, writing down nothing it did not finish", async () => {
    const controller = new AbortController();
    const roundTrip = vi.fn(allPass.roundTrip);
    const run = await checkHubSetup({
      folder: "/work",
      signal: controller.signal,
      probes: {
        ...allPass,
        installed: async () => {
          controller.abort();
          return { ok: true, detail: "1.2.3" };
        },
        roundTrip,
      },
    });
    expect(run.proved).toBe(false);
    expect(roundTrip).not.toHaveBeenCalled();
    expect(setupProved()).toBe(false);
  });
});
