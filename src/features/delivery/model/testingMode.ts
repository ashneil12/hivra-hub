// SC-3a: how hard a project's tasks are tested before they count as done. The engine is Rust
// (src-tauri/src/delivery/settings.rs `TestingMode`, read by src-tauri/src/firstmate/testing_mode.rs when a worker says
// done). This is the webview's typed read and write, and the words a person reads. The words match `TestingMode::label`
// and `TestingMode::description` in Rust, and a test keeps them from drifting apart.
//
// A value read from the app is untrusted: a word this build doesn't know reads as the default, never as a stricter or a
// looser mode.

import { invoke } from "@tauri-apps/api/core";

export const TESTING_MODES = ["at-ship", "light", "full", "off"] as const;
export type TestingMode = (typeof TESTING_MODES)[number];

/**
 * What a project with no choice gets: tasks only have to build, and tests and review run once, at ship. THE one place the default
 * is named on this side (Rust's is `DEFAULT_TESTING_MODE` in src-tauri/src/delivery/settings.rs). Every fallback below reads it,
 * so picking another default is this one line.
 */
export const DEFAULT_TESTING_MODE: TestingMode = "at-ship";

/** The name a person reads, and one line under it. */
export const TESTING_MODE_WORDS: Record<TestingMode, { label: string; description: string }> = {
  "at-ship": {
    label: "Test at ship",
    description:
      "Tasks only have to build, and a risky change gets a second model. Tests, proof tools, the end-to-end check and a review run once, when you ship.",
  },
  light: {
    label: "Light tests each task",
    description:
      "Every task that changes code runs the project's tests and gets a quick review. Proof tools and the end-to-end check run once, when you ship.",
  },
  full: {
    label: "Full checks each task",
    description:
      "Light, plus the task's own checks, the real-app check, proof tools and a second model that re-runs the proof on every code change.",
  },
  off: {
    label: "No testing",
    description: "Tasks are not tested or reviewed.",
  },
};

/** The line shown when a read or a write didn't go through and the app said nothing a person can use. */
export const TESTING_TRY_AGAIN = "That didn't go through. Try again.";

export function parseTestingMode(value: unknown): TestingMode | null {
  return typeof value === "string" && (TESTING_MODES as readonly string[]).includes(value)
    ? (value as TestingMode)
    : null;
}

/** What the app says about a project's testing choice, and the `updatedAt` the next write must be based on. */
export type TestingModeRead = {
  mode: TestingMode;
  /** The person has not chosen: `mode` is the default. */
  defaulted: boolean;
  /** None when the project has no row yet. A write passes it back so a stale window can't overwrite a newer choice. */
  updatedAt: number | null;
};

function updatedAtOf(row: Record<string, unknown>): number | null {
  return typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : null;
}

/**
 * `delivery_settings_get`'s answer. `null` when it isn't an object at all: that read failed. A saved choice is always kept;
 * `fallback` (the default constant, named only so a test can show every fallback follows it) fills in where nothing is saved or
 * the word isn't one this build knows.
 */
export function readEffective(value: unknown, fallback: TestingMode = DEFAULT_TESTING_MODE): TestingModeRead | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const mode = parseTestingMode(row.testingMode);
  return {
    mode: mode ?? fallback,
    defaulted: mode === null || row.testingDefaulted === true,
    updatedAt: updatedAtOf(row),
  };
}

/** `delivery_testing_mode_set`'s answer: the stored row, whose `testingMode` is none until the person chooses. */
export function readStored(value: unknown, fallback: TestingMode = DEFAULT_TESTING_MODE): TestingModeRead | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const mode = parseTestingMode(row.testingMode);
  return { mode: mode ?? fallback, defaulted: mode === null, updatedAt: updatedAtOf(row) };
}

/** What a failed call says: the app's own plain words when it gave some, else the usual line. */
export function failureLine(error: unknown): string {
  return typeof error === "string" && error.trim() ? error.trim() : TESTING_TRY_AGAIN;
}

/** The project's choice. Throws the line to show when the app can't say. */
export async function loadTestingMode(project: string): Promise<TestingModeRead> {
  let got: unknown;
  try {
    got = await invoke("delivery_settings_get", { project });
  } catch (error) {
    throw new Error(failureLine(error));
  }
  const read = readEffective(got);
  if (!read) throw new Error(TESTING_TRY_AGAIN);
  return read;
}

/**
 * Writes the choice on top of the row last read (`expectedUpdatedAt`, none when there was no row). A window that read an
 * older row is refused by the app with a plain line, which this throws as it is.
 */
export async function saveTestingMode(
  project: string,
  mode: TestingMode,
  expectedUpdatedAt: number | null,
): Promise<TestingModeRead> {
  let got: unknown;
  try {
    got = await invoke("delivery_testing_mode_set", { project, mode, expectedUpdatedAt });
  } catch (error) {
    throw new Error(failureLine(error));
  }
  const read = readStored(got);
  if (!read) throw new Error(TESTING_TRY_AGAIN);
  return read;
}
