// What the Connections card in Settings > Providers shows for each coding tool: the sign-ins and saved models it can
// run on today, which of those are extra connections this app makes for it, and what is set up in the tool itself.
// Pure: the caller passes what is installed and which providers have a saved model.
import type { HarnessId } from "../../sessions/model/session";
import { HARNESSES } from "../../sessions/model/session";
import {
  MODEL_SOURCES,
  isExtraConnection,
  modelConnection,
  workingSources,
  type ModelSource,
} from "./modelConnections";

export type ConnectionPill = {
  source: ModelSource;
  name: string;
  /** This app makes the connection (the router, or the Claude Code bridge). */
  extra: boolean;
  /** False when it still needs something: a saved model for that provider, or Claude Code installed. */
  ready: boolean;
  note: string;
};

export type ConnectionRow = {
  harness: HarnessId;
  pills: ConnectionPill[];
  /** Sources the tool takes in its own settings for now, by name. */
  inAgent: string[];
};

const KEY_SOURCES: ReadonlySet<ModelSource> = new Set(["xai", "openrouter", "deepseek", "ollama", "custom"]);

function sourceName(source: ModelSource): string {
  return MODEL_SOURCES.find((s) => s.id === source)?.name ?? source;
}

/** One row per installed tool, in the app's usual order. */
export function connectionRows(
  installed: (harness: HarnessId) => boolean,
  savedProviders: ReadonlySet<string>,
): ConnectionRow[] {
  return HARNESSES.filter(installed).map((harness) => ({
    harness,
    pills: workingSources(harness).map((source) => {
      const extra = isExtraConnection(harness, source);
      let ready = true;
      if (extra && KEY_SOURCES.has(source)) ready = savedProviders.has(source);
      if (extra && source === "claudeLogin") ready = installed("claude");
      return { source, name: sourceName(source), extra, ready, note: modelConnection(harness, source).note };
    }),
    inAgent: MODEL_SOURCES.filter((s) => modelConnection(harness, s.id).status === "agentSetup").map((s) => s.name),
  }));
}
