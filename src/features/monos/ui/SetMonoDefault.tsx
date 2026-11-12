// Ash 12 Nov: "it will be easy to just have a button in the selector to just set something as a default when you're on
// a mono". Beside a first mate's model picker: when this chat runs on something other than the first mate's own model,
// one tap makes it what the first mate's new chats start on.
import { useSyncExternalStore } from "react";
import { chatMonoOwner } from "../../hub/model/hubMcp";
import { findMono, monoForSession, monosSnapshot, subscribeMonos, updateMono } from "../model/mono";
import { modelOffersFast } from "../model/monoRun";
import { resolveModel } from "../../sessions/model/models";
import type { HarnessId } from "../../sessions/model/session";

export function SetMonoDefault({
  sessionId,
  harness,
  model,
  values,
}: {
  sessionId: string;
  harness: HarnessId;
  model: string;
  values: Record<string, string>;
}) {
  useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  const mono = monoForSession(sessionId) ?? findMono(chatMonoOwner(sessionId) ?? "");
  if (!mono) return null;
  const chosen = resolveModel(harness, model);
  const same =
    mono.engine === harness &&
    (mono.engineModel ? resolveModel(harness, mono.engineModel).id === chosen.id : false) &&
    (!values.effort || values.effort === mono.engineEffort);
  if (same) return null;
  const name = mono.name?.trim() || "this first mate";
  return (
    <button
      type="button"
      data-set-mono-default={mono.id}
      title={`New chats with ${name} start on ${chosen.name}`}
      className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
      onClick={() =>
        updateMono(mono.id, (current) => {
          const next = { ...current, engine: harness, engineModel: chosen.id };
          if (modelOffersFast(chosen) && values.fast !== undefined) next.engineFast = values.fast === "true";
          else delete next.engineFast;
          if (values.effort) next.engineEffort = values.effort;
          else delete next.engineEffort;
          return next;
        })
      }
    >
      Make default
    </button>
  );
}
