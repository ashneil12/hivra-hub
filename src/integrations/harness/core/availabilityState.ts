import type { HarnessId } from "../../../features/sessions/model/session";

/**
 * The probed installer state for every harness. Kept free of the binary
 * resolvers so the model layer can consult it without loading the whole
 * harness integration graph.
 */
export type HarnessAvailability = Record<HarnessId, boolean>;

let availability: HarnessAvailability = {
  claude: false,
  codex: false,
  cursor: false,
  grok: false,
  opencode: false,
  pi: false,
  omp: false,
  fx: false,
  hermes: false,
  antigravity: false,
  devin: false,
};
let version = 0;
let probedAt = 0;

/** What the engine knows of a tool it runs: Settings says it on the tool's row. */
export type HarnessEngineFacts = {
  version?: string;
  /** Unset when the engine cannot tell. */
  signedIn?: boolean;
  plan?: string;
  email?: string;
  /** The engine's own word on a tool that is not well. */
  note?: string;
  /** Switched off in the engine: nothing to install, it only has to be turned on there. */
  off?: boolean;
  /** The engine has no provider for it yet and can be given one that runs the tool's own command. */
  setUp?: boolean;
  /** The engine has no way to run it at all, so installing it would change nothing. */
  noRoute?: boolean;
};
let engineFacts: Partial<Record<HarnessId, HarnessEngineFacts>> = {};

/** Nothing when no engine runs this copy's chats, or it has not said yet. */
export function harnessEngineFacts(id: HarnessId): HarnessEngineFacts | undefined {
  return engineFacts[id];
}

export function setHarnessEngineFacts(next: Partial<Record<HarnessId, HarnessEngineFacts>>, said = false): void {
  engineFacts = next;
  engineSaid = said;
}

let engineSaid = false;

/** True when which tools can run is an engine's answer: one that cannot is then not simply "not installed". */
export function engineSaysWhichToolsRun(): boolean {
  return engineSaid;
}

let engineTurnOn: ((id: HarnessId) => Promise<void>) | null = null;

/**
 * How a tool the engine has switched off is turned on there, or one it has no provider for is given one; set by
 * whatever connects this copy to an engine.
 */
export function setHarnessEngineTurnOn(next: ((id: HarnessId) => Promise<void>) | null): void {
  engineTurnOn = next;
}

/** Turns the tool on (or sets it up) in the engine and looks again. Rejects with the engine's reason when it would not. */
export function turnOnInEngine(id: HarnessId): Promise<void> {
  return engineTurnOn ? engineTurnOn(id) : Promise.reject(new Error("No engine runs this copy's chats."));
}
const listeners = new Set<() => void>();

export function emitHarnessAvailability() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHarnessAvailability(
  onStoreChange: () => void,
): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getHarnessAvailabilitySnapshot(): number {
  return version;
}

export function hasProbedHarnessAvailability(): boolean {
  return probedAt > 0;
}

export function isHarnessAvailable(id: HarnessId): boolean {
  return availability[id];
}

export function setHarnessAvailability(next: HarnessAvailability): void {
  availability = next;
}

/** When the probe last finished, or `0` before the first probe. */
export function harnessAvailabilityProbedAt(): number {
  return probedAt;
}

export function markHarnessAvailabilityProbed(): void {
  probedAt = Date.now();
}

/** Puts the probe back to "not run yet" and every CLI to not installed. */
export function resetHarnessAvailabilityForTests(): void {
  engineFacts = {};
  engineSaid = false;
  availability = {
    claude: false,
    codex: false,
    cursor: false,
    grok: false,
    opencode: false,
    pi: false,
    omp: false,
    fx: false,
    hermes: false,
    antigravity: false,
    devin: false,
  };
  probedAt = 0;
  emitHarnessAvailability();
}
