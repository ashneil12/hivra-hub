// WP-132b: the review guide switch. Off until the person turns it on.

import { useSyncExternalStore } from "react";
import { playCue } from "../../settings/model/sounds";
import {
  loadReviewGuideEnabled,
  saveReviewGuideEnabled,
  subscribeReviewGuideEnabled,
} from "../../settings/model/settings";

export function ReviewGuideToggle() {
  const on = useSyncExternalStore(
    subscribeReviewGuideEnabled,
    loadReviewGuideEnabled,
    () => false,
  );
  return (
    <button
      type="button"
      role="switch"
      aria-label="Review guide"
      aria-checked={on}
      onClick={() => {
        saveReviewGuideEnabled(!on);
        playCue("switch");
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-content/20"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}
