// Three honest states for a Mono on the rail: working, idle, or can't tell (port map idea 4). Behaviour matched to
// Alan's Workspace (capthvnsen/alans-way @ 3dac36c, desktop/src/activity.cjs, GPL-3.0: our own code, nothing copied):
// a live signal counts for 6 s (ACTIVITY_TTL_MS), the feed that carries signals is trusted for 8 s after it was last
// heard (BRIDGE_TTL_MS), and a state the app can't know is never shown as idle. Ours: the signal is seeing the Mono's
// turn running; the feed is what the app knows of its chat. A Mono's turn only runs on a chat this window has loaded,
// so a chat that isn't loaded and wasn't running when last seen is known idle (Mono chats load lazily, when opened).
// The feed goes quiet only when a chat seen running leaves this window's store (moved to another window, or closed
// mid-turn): from then on the app can't see it, and after 8 s it says so. A Mono with no chat yet is idle. A turn seen
// stopped ends working at once (as Alan's `cancel` does).
export const SIGNAL_TTL_MS = 6000;
export const FEED_TTL_MS = 8000;

export type LiveState = "working" | "idle" | "unknown";

export type Seen = { feedAt?: number; signalAt?: number; busy?: boolean; gone?: boolean };

/** What a Mono is, from what was last seen of it. */
export function liveState(seen: Seen | undefined, hasChat: boolean, now: number): LiveState {
  if (!hasChat) return "idle";
  if (seen?.feedAt == null || now - seen.feedAt >= FEED_TTL_MS) return "unknown";
  if (seen.signalAt != null && now - seen.signalAt < SIGNAL_TTL_MS) return "working";
  return "idle";
}

/** One per window: what the app has seen of each Mono's chat. */
export class MonoLiveness {
  private seen = new Map<string, Seen>();

  /** The chat as the app has it now: `present` false when its record isn't loaded in this window. */
  note(monoId: string, chat: { present: boolean; busy: boolean }, now: number): void {
    if (chat.present) {
      this.seen.set(monoId, chat.busy ? { feedAt: now, signalAt: now, busy: true } : { feedAt: now });
      return;
    }
    // Not loaded: still known not running, unless it was last seen running (then the feed has gone quiet).
    const last = this.seen.get(monoId);
    if (last?.busy) this.seen.set(monoId, { ...last, gone: true });
    else this.seen.set(monoId, { feedAt: now });
  }

  /** When a state can next change with nothing else changing: a chat that left while running ages out of working
   * (6 s) and then out of sight (8 s). The rail re-reads then instead of ticking every second. */
  nextChange(now: number): number | undefined {
    let next: number | undefined;
    for (const seen of this.seen.values()) {
      if (!seen.gone) continue;
      for (const at of [(seen.signalAt ?? -Infinity) + SIGNAL_TTL_MS, (seen.feedAt ?? -Infinity) + FEED_TTL_MS]) {
        if (at > now && (next == null || at < next)) next = at;
      }
    }
    return next;
  }

  state(monoId: string, hasChat: boolean, now: number): LiveState {
    return liveState(this.seen.get(monoId), hasChat, now);
  }
}

export const monoLiveness = new MonoLiveness();
