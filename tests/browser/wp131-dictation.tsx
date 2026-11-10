// WP-131: the real composer, with the desktop dictation IPC answered by a fake (fakeTauri). The browser proves the
// control, the draft and the never-send rule without a Mac. The Rust side is unit-tested; this page only fakes its answers.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installFakeTauri } from "./fakeTauri";
import { Composer } from "../../src/features/sessions/ui/Composer";
import "../../src/styles/index.css";

type Calls = { starts: number; stops: number[]; submitted: string[]; startError: string | null };
const calls: Calls = { starts: 0, stops: [], submitted: [], startError: null };
const unsupported = new URLSearchParams(location.search).has("unsupported");
// `?hold`: the start never answers, so the permission wait stays on screen.
const hold = new URLSearchParams(location.search).has("hold");

const fake = installFakeTauri("main", (command, args) => {
  if (command === "dictation_support") {
    return unsupported ? { available: false, reason: "" } : { available: true, reason: "" };
  }
  if (command === "dictation_start") {
    if (hold) return new Promise(() => {});
    if (calls.startError) throw calls.startError;
    calls.starts += 1;
    return calls.starts;
  }
  if (command === "dictation_stop") {
    calls.stops.push(Number((args as { session?: unknown }).session));
    return null;
  }
  // The composer's listings (project files, skills, recents) expect arrays. Anything else it asks for is empty.
  return [];
});

Object.assign(window, {
  __dictation: calls,
  __emitDictation: (payload: unknown) => fake.emit("monocode:dictation", payload),
});

function Harness() {
  const [, setDraft] = useState("");
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    Object.assign(window, { __setEnabled: setEnabled });
  }, []);
  return (
    <Composer
      enabled={enabled}
      focused
      harness="claude"
      model="claude:sonnet-5"
      runtimeMode="supervised"
      cwd="/Users/example/Projects/hivra"
      executionCwd="/Users/example/Projects/hivra"
      hideProjectPicker
      hideBranchPicker
      hideTopBar
      inputAriaLabel="Message the lead"
      onSubmit={(text) => {
        calls.submitted.push(text);
        return true;
      }}
      onDraftChange={(text) => setDraft(text)}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
