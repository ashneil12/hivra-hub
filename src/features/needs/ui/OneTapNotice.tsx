import { useSyncExternalStore } from "react";
import { oneTapRefusal, subscribeOneTapRefusal } from "../model/oneTapNotice";

/** Why the last one tap was refused. Empty once it clears. */
export function OneTapNotice() {
  const text = useSyncExternalStore(subscribeOneTapRefusal, oneTapRefusal, () => undefined);
  if (!text) return null;
  return (
    <p data-needs-refusal role="status" className="text-[13px] leading-5 text-content/70">
      {text}
    </p>
  );
}
