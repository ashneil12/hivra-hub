// One framed page's side of the bridge (docs/pages-build-contract.md, "Connected pages"). The frame posts:
//   {type:"hub:call", id, call, args}    one read, or one of its taps; answered with {type:"hub:reply", id, ok, result|error}
//   {type:"hub:watch", id, call, args}   a live read: {type:"hub:reply", id, ok} then {type:"hub:data", watch: id, call, data}
//                                        now and whenever it changes (a burst folds into one push; the same data isn't sent
//                                        twice), until {type:"hub:unwatch", id}, the page closes, or Ash's Undo takes the
//                                        permission back ({type:"hub:watch-ended", watch, error})
//   {type:"hub:size", height}            how tall its content is; the frame follows it (clamped)
// The rules: a call runs only when the page asked for it and Ash approved it (bridge.ts); a preview may read the live data
// it asked for (so Ash sees what he keeps) but nothing else; a tap (pageActions.ts) runs only on a kept page and only while
// Ash's tap inside the page is fresh, so a page can never act by itself.
import { capabilityFor, refusal, WALL_REFUSAL, type BridgeCall } from "./bridge";
import { runPageAction, type ActionContext } from "./pageActions";
import { isLiveRead, isPageAction, isWall, LIVE_READS, type Capability, type LiveRead } from "./pageSpec";

export type PageSource = { read(args: Record<string, unknown>): unknown; subscribe(onChange: () => void): () => void };
export type PageSources = Record<LiveRead, PageSource>;

export const TAP_ONLY = "Pages act only when you tap something on them, so nothing was done.";
const PREVIEW_TAP = "This is a preview: its buttons work once you keep the page.";
const PREVIEW_OTHER = "This is a preview: it can do that once you keep the page.";
const WATCH_ONLY = `Only live data can be watched: ${LIVE_READS.slice(0, -1).join(", ")} or ${LIVE_READS[LIVE_READS.length - 1]}.`;
const MAX_WATCHES = 20;
export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 4000;

export type PageBridgeOptions = {
  pageId: string;
  title: string;
  /** A kept page (its approvals apply) or a preview. */
  live: boolean;
  /** What the page's spec asks for. */
  asks: readonly Capability[];
  /** What Ash approved for it right now (read again on every call and push: Undo takes it back at once). */
  approved(): readonly Capability[];
  /** Ash has just tapped inside the page. */
  tapped(): boolean;
  post(message: unknown): void;
  sources: PageSources;
  act?(call: string, args: Record<string, unknown>, ctx: ActionContext): Promise<unknown>;
  /** The longest a change waits before it reaches the page (a burst of changes is one push). */
  throttleMs?: number;
  onSize?(height: number): void;
};

type Watch = { call: LiveRead; args: Record<string, unknown>; off: () => void; timer?: ReturnType<typeof setTimeout>; last?: string };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class PageBridgeHost {
  private watches = new Map<string, Watch>();
  private closed = false;
  constructor(private readonly o: PageBridgeOptions) {}

  /** What this page may use now: what Ash approved, or (a preview) the live data it asked to read. */
  private allowed(): readonly Capability[] {
    return this.o.live ? this.o.approved() : this.o.asks.filter((a) => isLiveRead(a));
  }

  private why(call: Pick<BridgeCall, "call" | "args">): string | undefined {
    const cap = capabilityFor(call);
    if (isWall(cap) || isWall(call.call)) return WALL_REFUSAL;
    if (!this.o.live && this.o.asks.includes(cap as Capability) && !isLiveRead(cap)) return isPageAction(cap) ? PREVIEW_TAP : PREVIEW_OTHER;
    return refusal(call, this.allowed());
  }

  receive(raw: unknown): void {
    if (this.closed) return;
    const m = obj(raw);
    const id = typeof m.id === "string" ? m.id : "";
    const call = typeof m.call === "string" ? m.call : "";
    const args = obj(m.args);
    if (m.type === "hub:call") void this.call(id, call, args);
    else if (m.type === "hub:watch") this.watch(id, call, args);
    else if (m.type === "hub:unwatch") this.unwatch(id);
    else if (m.type === "hub:size" && typeof m.height === "number" && Number.isFinite(m.height))
      this.o.onSize?.(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(m.height))));
  }

  private reply(id: string, out: { ok: true; result: unknown } | { ok: false; error: string }): void {
    if (!this.closed) this.o.post({ type: "hub:reply", id, ...out });
  }

  private async call(id: string, call: string, args: Record<string, unknown>): Promise<void> {
    if (!call) return this.reply(id, { ok: false, error: "That isn't a page call." });
    const no = this.why({ call, args });
    if (no) return this.reply(id, { ok: false, error: no });
    try {
      if (isLiveRead(call)) return this.reply(id, { ok: true, result: this.o.sources[call].read(args) });
      if (isPageAction(call)) {
        if (!this.o.tapped()) return this.reply(id, { ok: false, error: TAP_ONLY });
        const ctx = { pageId: this.o.pageId, pageTitle: this.o.title };
        return this.reply(id, { ok: true, result: await (this.o.act ?? runPageAction)(call, args, ctx) });
      }
      this.reply(id, { ok: false, error: "Not connected yet: the hub can't do this for pages yet." });
    } catch (e) {
      this.reply(id, { ok: false, error: e instanceof Error && e.message ? e.message : "That didn't work." });
    }
  }

  private watch(id: string, call: string, args: Record<string, unknown>): void {
    if (!id) return;
    if (isWall(call)) return this.reply(id, { ok: false, error: WALL_REFUSAL });
    if (!isLiveRead(call)) return this.reply(id, { ok: false, error: WATCH_ONLY });
    const no = this.why({ call, args });
    if (no) return this.reply(id, { ok: false, error: no });
    if (this.watches.has(id)) this.unwatch(id);
    if (this.watches.size >= MAX_WATCHES) return this.reply(id, { ok: false, error: `A page can watch at most ${MAX_WATCHES} things at once.` });
    const w: Watch = { call, args, off: () => undefined };
    this.watches.set(id, w);
    w.off = this.o.sources[call].subscribe(() => this.schedule(id));
    this.reply(id, { ok: true, result: true });
    this.push(id);
  }

  private schedule(id: string): void {
    const w = this.watches.get(id);
    if (!w || w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = undefined;
      this.push(id);
    }, this.o.throttleMs ?? 250);
  }

  private push(id: string): void {
    const w = this.watches.get(id);
    if (!w || this.closed) return;
    const no = this.why({ call: w.call, args: w.args });
    if (no) {
      this.unwatch(id);
      this.o.post({ type: "hub:watch-ended", watch: id, error: no });
      return;
    }
    let data: unknown;
    try {
      data = this.o.sources[w.call].read(w.args);
    } catch {
      return; // the next change tries again
    }
    const text = JSON.stringify(data);
    if (text === w.last) return;
    w.last = text;
    this.o.post({ type: "hub:data", watch: id, call: w.call, data });
  }

  private unwatch(id: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    w.off();
    this.watches.delete(id);
  }

  /** The page closed or was swapped: let go of everything it watched. */
  dispose(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id);
    this.closed = true;
  }
}
