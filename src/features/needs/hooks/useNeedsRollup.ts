// Posts the Needs you roll-up (model/needsRollup.ts) into the pinned Chief of Staff chat when the list gains items.
// Mounted once, in the main window. A short settle batches items that arrive together into one line.

import { useEffect, useRef } from "react";
import { isCaptainMono } from "../../chief/model/charter";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { listMonos } from "../../monos/model/mono";
import type { Block } from "../../sessions/model/session";
import { useNeedsYou } from "../model/needsLive";
import { rollupLine, seedRollup, type RollupState } from "../model/needsRollup";
import type { NeedsItem } from "../model/needsYou";

const SETTLE_MS = 3_000;
/** The list loads in pieces at launch; what is there by then counts as already known. */
const LAUNCH_QUIET_MS = 20_000;

/** The Chief of Staff's own chat (the one its row on the rail opens), if there is one. */
export function chiefChatId(): string | undefined {
  try {
    return listMonos().find((mono) => isCaptainMono(mono))?.sessionId;
  } catch {
    return undefined;
  }
}

export function useNeedsRollup(input: {
  note: (chatId: string, block: Block) => void;
  label?: (item: NeedsItem) => string | undefined;
  /** False keeps the line off (a dev copy's tests, or the main chat's own setting). */
  enabled?: boolean;
}): void {
  const items = useNeedsYou();
  const latest = useRef(input);
  latest.current = input;
  const state = useRef<RollupState | null>(null);
  const started = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(items);
  current.current = items;
  useEffect(() => {
    if (!IS_HUB_BUNDLE || latest.current.enabled === false) return;
    if (Date.now() - started.current < LAUNCH_QUIET_MS || !state.current) {
      // Until the launch settles, keep learning what is already waiting.
      state.current = seedRollup(items);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const chat = chiefChatId();
      if (!chat || !state.current) return;
      const out = rollupLine(current.current, state.current, Date.now(), latest.current.label);
      if (!out) return;
      state.current = out.state;
      latest.current.note(chat, out.block);
    }, SETTLE_MS);
  }, [items]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
}
