// WP-164: looks for a notable-event ping that has become due (model/notableDelivery.ts): a held notice when the quiet
// window ends, a second failure when its interval has passed. Only the main window sends, like the PR watch that
// records most of them. It runs inside the app's root and renders nothing.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { NOTABLE_LOOK_MS, flushNotableDue } from "../model/notableDelivery";

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function useNotablePings(): void {
  useEffect(() => {
    if (!isMainWindow()) return;
    const look = () => {
      void flushNotableDue().catch((error: unknown) => console.warn("Could not look for a due ping", error));
    };
    look();
    const timer = setInterval(look, NOTABLE_LOOK_MS);
    return () => clearInterval(timer);
  }, []);
}
