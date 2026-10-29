// What has to be true before the Hub can hold a chat (H7): Claude Code is installed, it is signed in, there is a folder
// to work in, and one round trip actually answers. Each is checked for real, not asked about, and the ones that passed
// are written down, so an install that has been proved is never asked again. A recorded fact is what was true when it
// was checked; "Check again" checks everything afresh (a failure is shown, but never erases the record).
//
// Kept free of React and of Ash OS data: the card hands in the folders its projects already have.
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import {
  canRunHarnessTextPrompt,
  harnessUnavailableHint,
  runHarnessTextPrompt,
} from "../../../integrations/harness";
import { inspectHarnessBinary } from "../../../integrations/harness/core/child";
import type { ConfigurableBinaryProvider } from "../../providers/model/providerBinaryPaths";
import { loadProviderBinaryPath } from "../../providers/model/providerBinaryPaths";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  type ProviderAccountProvider,
} from "../../providers/model/providerAccounts";
import { readProviderAccountIdentity } from "../../providers/model/providerAccountIdentity";

/** The Hub's default engine is Claude Code (hubBundle.ts seeds new chats on it). */
const HARNESS: ConfigurableBinaryProvider & ProviderAccountProvider = "claude";

const PROOF_KEY = "monocode:hub-setup-proof";
const FOLDER_KEY = "monocode:hub-setup-folder";
/** r61: Ash said "Not now" to the setup card; it stays away on later launches (PM's blind run saw it come back). */
const SNOOZE_KEY = "monocode:hub-setup-not-now";
const PROOF_VERSION = 1;

export type SetupFactId = "installed" | "signedIn" | "folder" | "roundTrip";

/** The order the card shows them in: each one is only usable when everything above it is. */
export const SETUP_FACT_IDS: readonly SetupFactId[] = ["installed", "signedIn", "folder", "roundTrip"];

export type SetupState = "checking" | "proved" | "missing";

export type SetupCheck = {
  id: SetupFactId;
  state: SetupState;
  /** One plain sentence: what was found, or what is missing. Empty while checking. */
  detail: string;
};

export type SetupProbeResult = { ok: boolean; detail: string };

/** The four checks, injectable so a test never runs a real CLI. */
export type SetupProbes = {
  installed: () => Promise<SetupProbeResult>;
  signedIn: () => Promise<SetupProbeResult>;
  /** Whether `path` is a folder that can be worked in. */
  folder: (path: string) => Promise<SetupProbeResult>;
  /** One real prompt in `path`; a non-empty answer is the proof. */
  roundTrip: (path: string, signal?: AbortSignal) => Promise<SetupProbeResult>;
};

export type CheckHubSetupInput = {
  /** A folder the person just picked. Falls back to the remembered one, then the projects' folders. */
  folder?: string | null;
  /** Folders existing projects work in, so an install that already has projects is not asked to pick one again. */
  knownFolders?: readonly (string | null | undefined)[];
  /** Last resorts when nothing above is a folder (defaultWorkFolders: ~/Projects, then the home folder). */
  fallbackFolders?: readonly (string | null | undefined)[];
  /** Check every fact again, even the ones proved before. */
  refresh?: boolean;
  signal?: AbortSignal;
  probes?: Partial<SetupProbes>;
  /** Called after every change, so the card fills in one row at a time. */
  onCheck?: (checks: SetupCheck[]) => void;
};

export type SetupRun = {
  /** One row per fact, in SETUP_FACT_IDS order. */
  checks: SetupCheck[];
  /** True when every fact is proved in this run. */
  proved: boolean;
};

/** Anything that looks like a path on this Mac ("/Users/…", "~/…"). */
const PATH = /(?:~|\/(?:Users|home|opt|usr|Applications|Volumes|private|var|tmp|Library))\/[^\s:,;'"()]*/g;

function lastPart(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * A check's detail in plain words, as the card shows it (Critiquito, 0.16.3 blocker): never the account's email, never
 * a raw path. The Grok launcher reads "Grok 4.7 ready"; a folder is named by its last part. Applied to what is stored
 * too, so a record written by an older version (with the email or a path in it) reads the same way.
 */
export function plainSetupDetail(id: SetupFactId, detail: string): string {
  const text = detail.trim();
  if (!text) return text;
  if (id === "signedIn") return /@|^Signed in as\b/i.test(text) ? "Signed in" : text;
  if (id === "installed" && /claude-grok/i.test(text) && !/did not answer|could not/i.test(text)) return "Grok 4.7 ready";
  if (id === "installed" && new RegExp(PATH.source).test(text) && !/did not answer|could not/i.test(text)) {
    const version = text.replace(PATH, "").replace(/\bat\b\s*$/i, "").replace(/\(Claude Code\)/i, "").trim();
    return version ? `Claude Code ${version} ready` : "Claude Code ready";
  }
  if (id === "folder" && text.startsWith("/") && !/\s/.test(text)) return `Working in ${lastPart(text)}`;
  // Failures keep their sentence, with each path cut to its last part.
  return text.replace(PATH, (path) => (/claude-grok/i.test(path) ? "the Grok launcher" : lastPart(path))).replace(/\s+/g, " ");
}

type ProvedFact = { at: number; detail: string };
type StoredProof = { version: number; facts: Partial<Record<SetupFactId, ProvedFact>> };

function readStored(): StoredProof {
  const empty: StoredProof = { version: PROOF_VERSION, facts: {} };
  try {
    const raw = localStorage.getItem(PROOF_KEY);
    if (!raw) return empty;
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return empty;
    const record = value as { version?: unknown; facts?: unknown };
    if (record.version !== PROOF_VERSION) return empty;
    if (typeof record.facts !== "object" || record.facts === null) return empty;
    const facts: StoredProof["facts"] = {};
    for (const id of SETUP_FACT_IDS) {
      const fact = (record.facts as Record<string, unknown>)[id] as Partial<ProvedFact> | undefined;
      if (fact && typeof fact.at === "number" && typeof fact.detail === "string")
        facts[id] = { at: fact.at, detail: fact.detail };
    }
    return { version: PROOF_VERSION, facts };
  } catch {
    return empty;
  }
}

function writeStored(proof: StoredProof): void {
  try {
    localStorage.setItem(PROOF_KEY, JSON.stringify(proof));
  } catch {
    /* best effort: without storage the card simply asks again next launch */
  }
}

/** The facts proved so far, newest write wins. */
export function setupFacts(): Partial<Record<SetupFactId, ProvedFact>> {
  return readStored().facts;
}

/** True once all four have been proved at least once. */
export function setupProved(): boolean {
  const facts = readStored().facts;
  return SETUP_FACT_IDS.every((id) => facts[id] != null);
}

/** Write down a fact that just passed. A failed check never calls this, and never removes an older proof. */
export function recordSetupFact(id: SetupFactId, detail: string): void {
  const proof = readStored();
  proof.facts[id] = { at: Date.now(), detail: plainSetupDetail(id, detail).slice(0, 240) };
  writeStored(proof);
}

/** What the card shows before anything has been checked: what was proved before, the rest as still checking. */
export function recordedSetupChecks(): SetupCheck[] {
  const facts = readStored().facts;
  return SETUP_FACT_IDS.map((id) => {
    const fact = facts[id];
    return fact
      ? { id, state: "proved" as const, detail: plainSetupDetail(id, fact.detail) }
      : { id, state: "checking" as const, detail: "" };
  });
}

/** The folder the folder check passed on in an earlier run. */
export function chosenSetupFolder(): string | null {
  try {
    const path = localStorage.getItem(FOLDER_KEY)?.trim();
    return path ? path : null;
  } catch {
    return null;
  }
}

export function rememberSetupFolder(path: string): void {
  try {
    const trimmed = path.trim();
    if (trimmed) localStorage.setItem(FOLDER_KEY, trimmed);
    else localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* best effort */
  }
}

type PathInfo = { path: string; name: string; size: number; isDir: boolean };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultProbes: SetupProbes = {
  installed: async () => {
    try {
      const binary = loadProviderBinaryPath(HARNESS);
      const info = await inspectHarnessBinary(HARNESS, binary);
      if (info.error) return { ok: false, detail: `Claude Code at ${info.path} did not answer: ${info.error}` };
      return { ok: true, detail: info.version ? `${info.version} at ${info.path}` : info.path };
    } catch (error) {
      const message = messageOf(error);
      return {
        ok: false,
        detail: /not found|ENOENT|no such file/i.test(message) ? harnessUnavailableHint(HARNESS) : `Claude Code could not be started: ${message}`,
      };
    }
  },
  signedIn: async () => {
    const identity = await readProviderAccountIdentity(HARNESS, DEFAULT_PROVIDER_ACCOUNT_ID);
    if (!identity) return { ok: false, detail: "No Claude Code account is signed in on this Mac yet." };
    const who = identity.email || identity.name || identity.organization;
    return { ok: true, detail: who ? `Signed in as ${who}.` : "Claude Code is signed in." };
  },
  folder: async (path) => {
    try {
      const infos = await invoke<PathInfo[]>("inspect_paths", { paths: [path] });
      const info = infos[0];
      if (!info) return { ok: false, detail: `There is no folder at ${path}.` };
      if (!info.isDir) return { ok: false, detail: `${path} is a file, not a folder.` };
      return { ok: true, detail: path };
    } catch {
      return { ok: false, detail: `Could not check ${path}.` };
    }
  },
  roundTrip: async (path, signal) => {
    if (!canRunHarnessTextPrompt(HARNESS)) return { ok: false, detail: "Claude Code is not connected in this app yet." };
    const started = Date.now();
    try {
      const reply = await runHarnessTextPrompt({
        harness: HARNESS,
        cwd: path,
        prompt: "This is a connection check. Reply with the single word READY and nothing else.",
        timeoutMs: 60_000,
        signal,
      });
      if (!reply.trim()) return { ok: false, detail: "Claude Code answered with nothing." };
      const seconds = Math.max(0.1, (Date.now() - started) / 1000).toFixed(1);
      return { ok: true, detail: `Answered in ${seconds} s.` };
    } catch (error) {
      const message = messageOf(error).trim();
      return { ok: false, detail: message ? `No answer: ${message}` : "Claude Code did not answer." };
    }
  },
};

function folderCandidates(input: CheckHubSetupInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [input.folder, chosenSetupFolder(), ...(input.knownFolders ?? []), ...(input.fallbackFolders ?? [])]) {
    const path = value?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Run the four checks in order and write down each one that passes. Nothing is asked of the person: a check that
 * cannot pass yet says what is missing instead of guessing.
 */
export async function checkHubSetup(input: CheckHubSetupInput = {}): Promise<SetupRun> {
  const probes: SetupProbes = { ...defaultProbes, ...input.probes };
  const refresh = input.refresh === true;
  const facts = setupFacts();
  const checks: Record<SetupFactId, SetupCheck> = {
    installed: facts.installed
      ? { id: "installed", state: "proved", detail: plainSetupDetail("installed", facts.installed.detail) }
      : { id: "installed", state: "checking", detail: "" },
    signedIn: facts.signedIn
      ? { id: "signedIn", state: "proved", detail: plainSetupDetail("signedIn", facts.signedIn.detail) }
      : { id: "signedIn", state: "checking", detail: "" },
    folder: facts.folder
      ? { id: "folder", state: "proved", detail: plainSetupDetail("folder", facts.folder.detail) }
      : { id: "folder", state: "checking", detail: "" },
    roundTrip: facts.roundTrip
      ? { id: "roundTrip", state: "proved", detail: plainSetupDetail("roundTrip", facts.roundTrip.detail) }
      : { id: "roundTrip", state: "checking", detail: "" },
  };
  const publish = () => input.onCheck?.(SETUP_FACT_IDS.map((id) => checks[id]));
  const aborted = () => input.signal?.aborted === true;
  const prove = (id: SetupFactId, detail: string) => {
    checks[id] = { id, state: "proved", detail: plainSetupDetail(id, detail) };
    recordSetupFact(id, detail);
  };
  const miss = (id: SetupFactId, detail: string) => {
    checks[id] = { id, state: "missing", detail: plainSetupDetail(id, detail) };
  };

  const needed = (id: SetupFactId) => refresh || facts[id] == null;

  publish();
  if (needed("installed")) {
    const result = await probes.installed();
    if (aborted()) return { checks: SETUP_FACT_IDS.map((id) => checks[id]), proved: false };
    if (result.ok) prove("installed", result.detail);
    else miss("installed", result.detail);
    publish();
  }

  if (needed("signedIn")) {
    const result = await probes.signedIn();
    if (aborted()) return { checks: SETUP_FACT_IDS.map((id) => checks[id]), proved: false };
    if (result.ok) prove("signedIn", result.detail);
    else miss("signedIn", result.detail);
    publish();
  }

  if (needed("folder")) {
    const candidates = folderCandidates(input);
    let failure = "No folder to work in yet. Choose the folder your work lives in.";
    let provedFolder = false;
    for (const path of candidates) {
      if (aborted()) break;
      const result = await probes.folder(path);
      if (result.ok) {
        rememberSetupFolder(path);
        prove("folder", result.detail);
        publish();
        provedFolder = true;
        break;
      }
      failure = result.detail;
    }
    if (!provedFolder && !aborted()) {
      miss("folder", failure);
      publish();
    }
    if (aborted()) return { checks: SETUP_FACT_IDS.map((id) => checks[id]), proved: false };
  }

  // The round trip needs a working CLI and a folder; the sign-in is not a gate on it, because an answer that comes
  // back is itself proof of a working sign-in (an API-key setup has no account name on disk).
  const canAnswer = checks.installed.state === "proved" && checks.folder.state === "proved";
  if (needed("roundTrip")) {
    if (canAnswer) {
      const path = chosenSetupFolder() ?? input.folder?.trim() ?? folderCandidates(input)[0] ?? "";
      const result = await probes.roundTrip(path, input.signal);
      if (aborted()) return { checks: SETUP_FACT_IDS.map((id) => checks[id]), proved: false };
      if (result.ok) {
        prove("roundTrip", result.detail);
        publish();
        if (checks.signedIn.state !== "proved") {
          const detail = "The test message was answered, so Claude Code is signed in.";
          prove("signedIn", detail);
          publish();
        }
      } else {
        miss("roundTrip", result.detail);
        publish();
      }
    } else {
      miss("roundTrip", checks.installed.state === "proved" ? "Needs a folder first." : "Needs Claude Code first.");
      publish();
    }
  }

  const rows = SETUP_FACT_IDS.map((id) => checks[id]);
  return { checks: rows, proved: rows.every((row) => row.state === "proved") };
}

/**
 * Where work can happen when no project names a folder yet (0.16.3: "No folder to work in yet" on every launch, though
 * Ash's Mac has both): ~/Projects, then the home folder. The folder check still proves each one exists.
 */
export async function defaultWorkFolders(): Promise<string[]> {
  try {
    const home = await homeDir();
    return [await join(home, "Projects"), home];
  } catch {
    return [];
  }
}

/** r61: "Not now" on the setup card is remembered, so the card stays away on later launches. Proving nothing. */
export function snoozeSetupCard(now = Date.now()): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(now));
  } catch {
    /* best effort */
  }
}
/** Whether Ash said "Not now" to the setup card on this Mac. */
export function setupCardSnoozed(): boolean {
  try {
    return localStorage.getItem(SNOOZE_KEY) !== null;
  } catch {
    return false;
  }
}
