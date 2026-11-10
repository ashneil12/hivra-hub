// One framed page's side of the bridge (docs/pages-build-contract.md, "Connected pages"). The frame posts:
//   {type:"hub:call", id, call, args}    one read, or one of its taps; answered with {type:"hub:reply", id, ok, result|error}
//   {type:"hub:watch", id, call, args}   a live read: {type:"hub:reply", id, ok} then {type:"hub:data", watch: id, call, data}
//                                        now and whenever it changes (a burst folds into one push; the same data isn't sent
//                                        twice), until {type:"hub:unwatch", id}, the page closes, or Ash's Undo takes the
//                                        permission back ({type:"hub:watch-ended", watch, error})
//   {type:"hub:size", height}            how tall its content is; the frame follows it (clamped)
// The rules: a call runs only when the page asked for it and Ash approved it (bridge.ts); a preview may read the data it
// asked for (so Ash sees what he keeps) but nothing else; a tap (pageActions.ts) runs only on a kept page and only while
// Ash's tap inside the page is fresh, so a page can never act by itself.
import { refusal, WALL_REFUSAL, type BridgeCall, type BridgeHandlers } from "./bridge";
import { beginPageAction, notePageActionFailure, runPageAction, type ActionContext } from "./pageActions";
import { isLiveRead, isRead, isTapCall, isWall, LIVE_READS, type Capability, type LiveRead } from "./pageSpec";

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
  /** Return false when the frame did not take the message. Anything else counts as sent. */
  post(message: unknown): unknown;
  sources: PageSources;
  act?(call: string, args: Record<string, unknown>, ctx: ActionContext): Promise<unknown>;
  /** What answers a write or a hub read (pageCapabilities.ts). Without it an approved call says it isn't connected. */
  handlers?: BridgeHandlers;
  /** The longest a change waits before it reaches the page (a burst of changes is one push). */
  throttleMs?: number;
  onSize?(height: number): void;
  /**
   * This frame's nonce, built into its document (sandbox.ts). With it the host answers only a document that has said
   * hello with it, and wants a fresh hello after every `load` (loaded()). A frame keeps one contentWindow across
   * navigations, so a window can't tell the page from whatever it navigated to; the nonce can.
   */
  nonce?: string;
  /** How long after a `load` the document has to hello before the frame counts as navigated away (default 1500 ms). */
  helloMs?: number;
  /** The frame left its page: the owner puts a fresh frame and a fresh bridge in its place. */
  onLost?(): void;
};

type Watch = { call: LiveRead; args: Record<string, unknown>; off: () => void; timer?: ReturnType<typeof setTimeout>; last?: string; lastError?: string; misses?: number };
/** A frame that is mid-reload drops a push. Try that snapshot again, then stop so a gone frame does not spin. */
const MAX_MISSED_PUSHES = 8;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class PageBridgeHost {
  private watches = new Map<string, Watch>();
  private closed = false;
  private trusted: boolean;
  private lostFrame = false;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the document sent before its hello (or between a load and the next hello): answered only if the hello comes. */
  private held: unknown[] = [];
  constructor(private readonly o: PageBridgeOptions) {
    this.trusted = o.nonce === undefined;
  }

  /**
   * The frame fired `load`: a duplicate for the same document (WebKit does this for srcdoc) or a navigation. Nothing
   * is trusted until the document there says hello with the nonce; the ping makes the same document do it again.
   */
  loaded(): void {
    if (this.closed || this.o.nonce === undefined || this.lostFrame) return;
    this.trusted = false;
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => this.lost(), this.o.helloMs ?? 1500);
    this.o.post({ type: "hub:ping" });
  }

  private lost(): void {
    if (this.lostFrame || this.closed) return;
    this.lostFrame = true;
    this.trusted = false;
    this.held = [];
    clearTimeout(this.helloTimer);
    this.o.onLost?.();
  }

  /** What this page may use now: what Ash approved, or (a preview) the data it asked to read. */
  private allowed(): readonly Capability[] {
    return this.o.live ? this.o.approved() : this.o.asks.filter((a) => isRead(a));
  }

  private why(call: Pick<BridgeCall, "call" | "args">): string | undefined {
    if (isWall(call.call)) return WALL_REFUSAL;
    // `sessions.read` and `http.fetch` can't be asked for as permissions (pageSpec.ts knows a fixed set), so they never
    // appear in `asks`. A page's chats are behind its agents read and its refusal; a web source is behind the page's own
    // grants (pageGrants.ts), and the handler refuses an address nobody connected in plain words.
    if (call.call === "sessions.read") return refusal({ call: "agents.read" }, this.allowed(), this.o.asks);
    if (call.call === "http.fetch") return undefined;
    if (!this.o.live && this.o.asks.includes(call.call as Capability) && !isRead(call.call)) return isTapCall(call.call) ? PREVIEW_TAP : PREVIEW_OTHER;
    return refusal(call, this.allowed(), this.o.asks);
  }

  receive(raw: unknown): void {
    if (this.closed || this.lostFrame) return;
    const m = obj(raw);
    if (this.o.nonce !== undefined) {
      if (m.type === "hub:hello") {
        if (m.nonce !== this.o.nonce) return this.lost();
        clearTimeout(this.helloTimer);
        this.trusted = true;
        const held = this.held;
        this.held = [];
        for (const h of held) this.receive(h);
        return;
      }
      if (!this.trusted) {
        if (this.held.length < 50) this.held.push(raw);
        return;
      }
    }
    const id = typeof m.id === "string" ? m.id : "";
    const call = typeof m.call === "string" ? m.call : "";
    const args = obj(m.args);
    if (m.type === "hub:call") void this.call(id, call, args);
    else if (m.type === "hub:watch") this.watch(id, call, args);
    else if (m.type === "hub:unwatch") this.unwatch(id);
    else if (m.type === "hub:size" && typeof m.height === "number" && Number.isFinite(m.height))
      this.o.onSize?.(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(m.height))));
  }

  /** One of Ash's taps: "Sending…" on the page while it runs, then what happened or why it didn't (r61). */
  private async tap(id: string, call: string, args: Record<string, unknown>): Promise<void> {
    if (!this.o.tapped()) {
      notePageActionFailure(this.o.pageId, TAP_ONLY);
      return this.reply(id, { ok: false, error: TAP_ONLY });
    }
    const ctx = { pageId: this.o.pageId, pageTitle: this.o.title };
    const end = beginPageAction(this.o.pageId);
    try {
      this.reply(id, { ok: true, result: await (this.o.act ?? runPageAction)(call, args, ctx) });
    } catch (e) {
      const error = e instanceof Error && e.message ? e.message : "That didn't work.";
      notePageActionFailure(this.o.pageId, error);
      this.reply(id, { ok: false, error });
    } finally {
      end();
    }
  }

  private reply(id: string, out: { ok: true; result: unknown } | { ok: false; error: string }): void {
    if (!this.closed) this.o.post({ type: "hub:reply", id, ...out });
  }

  private async call(id: string, call: string, args: Record<string, unknown>): Promise<void> {
    if (!call) return this.reply(id, { ok: false, error: "That isn't a page call." });
    const no = this.why({ call, args });
    // r61: a tap that is refused says so on the page too (the app's line), not only to the page's code.
    if (no) {
      if (isTapCall(call) && this.o.live) notePageActionFailure(this.o.pageId, no);
      return this.reply(id, { ok: false, error: no });
    }
    if (isTapCall(call)) return this.tap(id, call, args);
    try {
      if (isLiveRead(call)) return this.reply(id, { ok: true, result: this.o.sources[call].read(args) });
      const run = this.o.handlers?.[call];
      if (run) return this.reply(id, { ok: true, result: await run(args) });
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
    if (!w || this.closed) return;
    w.misses = 0;
    if (w.timer) return;
    this.arm(id);
  }

  /** The frame missed a push. Same wait as a change, but a bounded number of tries and not a new change. */
  private retry(id: string): void {
    const w = this.watches.get(id);
    if (!w || this.closed || w.timer) return;
    w.misses = (w.misses ?? 0) + 1;
    if (w.misses > MAX_MISSED_PUSHES) return;
    this.arm(id);
  }

  private arm(id: string): void {
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
    } catch (e) {
      // The page hears why (its onError), so it never sits blank in silence; the watch stays and the next change tries again.
      const error = e instanceof Error && e.message ? `Couldn't read that just now: ${e.message}` : "Couldn't read that just now.";
      if (w.lastError !== error) {
        w.lastError = error;
        this.o.post({ type: "hub:watch-error", watch: id, error });
      }
      return;
    }
    w.lastError = undefined;
    const text = JSON.stringify(data);
    if (text === w.last) return;
    if (this.o.post({ type: "hub:data", watch: id, call: w.call, data }) === false) {
      this.retry(id);
      return;
    }
    w.misses = 0;
    w.last = text;
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
    clearTimeout(this.helloTimer);
    this.closed = true;
  }
}
