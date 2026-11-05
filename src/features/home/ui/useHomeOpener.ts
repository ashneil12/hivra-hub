// The app's hands for a line on Home. One call from the workspace.

import { useEffect, useRef } from "react";
import { applyHomeOpen, setHomeOpener, type HomeOpenHands } from "../model/opener";

export function useHomeOpener(hands: HomeOpenHands): void {
  const ref = useRef(hands);
  ref.current = hands;
  useEffect(() => setHomeOpener((target) => applyHomeOpen(target, ref.current)), []);
}
