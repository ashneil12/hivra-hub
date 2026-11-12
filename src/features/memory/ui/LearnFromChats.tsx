// WP-83: proposals from past chats, in the memory screen. Nothing is written here.
// The ports let a browser test drive it without Tauri.

import { useEffect, useRef, useState } from "react";
import type { Schedule } from "../backpass/schedule";
import { weeklyDue } from "../backpass/schedule";
import { formatTokens } from "../backpass/tokens";
import { textAfterLoad, textAfterSave } from "./profileDraft";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export type ShownProposal = {
  id: string;
  title: string;
  diff: string;
  quotes: { sessionId: string; quote: string }[];
  /** A plain sentence under the edit, when there is something to know before accepting it. */
  note?: string;
};

export type LearnProfiles = {
  opinions: string;
  voice: string;
  opinionsSha256: string;
  voiceSha256: string;
};

/** What a run would read, shown before it starts. */
export type LearnEstimate = {
  chats: number;
  tokens: number;
  /** The signed-in model that would answer, or null when none is set up yet. */
  model: string | null;
  /** Older chats the list left out, and chats too big to read. */
  leftOut: number;
  tooBig: number;
};

export type LearnRunInput = {
  includeUserFile: boolean;
  /** Only chats changed at or after this time (unix milliseconds). */
  fromMs?: number;
  /** Only chats from these project folders. */
  projects?: string[];
  /** About how many chats to read. */
  budget?: number;
};

export type LearnRunResult = { proposals: ShownProposal[]; chats: number };

export type LearnPorts = {
  cost: () => Promise<number>;
  /** Chats, tokens and model, before a run. A screen without it falls back to `cost`. */
  estimate?: (input?: Pick<LearnRunInput, "fromMs" | "projects" | "budget">) => Promise<LearnEstimate>;
  /** A bare list is a run that did not say how many chats it read. */
  run: (input: LearnRunInput) => Promise<ShownProposal[] | LearnRunResult>;
  /** A finished run's suggestions nobody has decided yet (one started from onboarding, say). */
  batch?: () => LearnRunResult | null;
  accept: (id: string) => Promise<boolean>;
  reject: (id: string) => Promise<boolean>;
  loadProfiles: () => Promise<LearnProfiles>;
  saveProfile: (which: "opinions" | "voice", text: string, expectedSha256: string) => Promise<boolean>;
  schedule: () => Promise<Schedule>;
  setWeekly: (weekly: boolean) => Promise<boolean>;
  markOffered: (at: string) => Promise<boolean>;
  /**
   * WP-157: edits a work log retro left waiting. Accepting or rejecting one goes through
   * `accept` and `reject` above. A screen with no work log behind it leaves this out.
   */
  staged?: () => Promise<ShownProposal[]>;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function LearnFromChats({ ports, now = Date.now }: { ports: LearnPorts; now?: () => number }) {
  const [cost, setCost] = useState<number | null>(null);
  const [costFailed, setCostFailed] = useState(false);
  const [proposals, setProposals] = useState<ShownProposal[] | null>(null);
  const [estimate, setEstimate] = useState<LearnEstimate | null>(null);
  const [batchChats, setBatchChats] = useState(0);
  const [waiting, setWaiting] = useState<ShownProposal[]>([]);
  const [profiles, setProfiles] = useState<LearnProfiles | null>(null);
  const [opinions, setOpinions] = useState("");
  const [voice, setVoice] = useState("");
  const [weekly, setWeekly] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [heldOffer, setHeldOffer] = useState(false);
  const [offerTick, setOfferTick] = useState(0);
  const [includeUser, setIncludeUser] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const nowRef = useRef(now);
  nowRef.current = now;
  const opinionsDirty = useRef(false);
  const voiceDirty = useRef(false);
  const offerAttempts = useRef(0);

  async function loadCost() {
    try {
      const found = portsRef.current.estimate ? await portsRef.current.estimate() : null;
      const value = found ? found.tokens : await portsRef.current.cost();
      if (!Number.isFinite(value) || value < 0) throw new Error("The cost could not be counted. Try again.");
      setEstimate(found);
      setCost(value);
      setCostFailed(false);
    } catch (error) {
      setCost(null);
      setCostFailed(true);
      setNote(message(error, "The cost could not be counted. Try again."));
    }
  }

  async function loadRest() {
    try {
      const [nextProfiles, nextSchedule] = await Promise.all([
        portsRef.current.loadProfiles(),
        portsRef.current.schedule(),
      ]);
      setProfiles(nextProfiles);
      setOpinions((typed) => textAfterLoad(typed, opinionsDirty.current, nextProfiles.opinions));
      setVoice((typed) => textAfterLoad(typed, voiceDirty.current, nextProfiles.voice));
      setSchedule(nextSchedule);
      setWeekly(nextSchedule.weekly === true);
    } catch (error) {
      setNote(message(error, "The profile could not be read. Try again."));
    }
  }

  async function loadWaiting() {
    if (!portsRef.current.staged) return;
    try {
      setWaiting(await portsRef.current.staged());
    } catch {
      setNote("The edits from the work log could not be read. Try again.");
    }
  }

  useEffect(() => {
    void loadCost();
    void loadRest();
    void loadWaiting();
    // A run started somewhere else (onboarding) leaves its suggestions waiting here.
    const kept = portsRef.current.batch?.();
    if (kept && kept.proposals.length > 0) {
      setProposals(kept.proposals);
      setBatchChats(kept.chats);
    }
  }, []);

  useEffect(() => {
    if (!schedule || heldOffer || !weeklyDue(schedule, nowRef.current())) return;
    const ms = nowRef.current();
    if (!Number.isFinite(ms)) return;
    const at = new Date(ms).toISOString();
    let cancelled = false;
    void (async () => {
      let ok = false;
      try {
        ok = await portsRef.current.markOffered(at);
      } catch {
        ok = false;
      }
      if (cancelled) return;
      if (ok) {
        setHeldOffer(true);
        setSchedule((current) => (current ? { ...current, lastOfferedAt: at } : current));
        return;
      }
      offerAttempts.current += 1;
      if (offerAttempts.current > 2) return;
      try {
        const fresh = await portsRef.current.schedule();
        if (!cancelled) setSchedule(fresh);
      } catch {
        if (!cancelled) setOfferTick((tick) => tick + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schedule, heldOffer, offerTick]);

  async function onRun() {
    if (busyRef.current || cost === null) return;
    const ticket = generation.current + 1;
    generation.current = ticket;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const result = await portsRef.current.run({ includeUserFile: includeUser });
      if (ticket !== generation.current) return;
      const rows = Array.isArray(result) ? result : result.proposals;
      setProposals(rows);
      setBatchChats(Array.isArray(result) ? 0 : result.chats);
      if (rows.length === 0) setNote("No edits from these chats.");
    } catch (error) {
      if (ticket !== generation.current) return;
      setNote(message(error, "The chats could not be read. Try again."));
    } finally {
      if (ticket === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function decide(id: string, kind: "accept" | "reject") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const ok = kind === "accept" ? await portsRef.current.accept(id) : await portsRef.current.reject(id);
      if (!ok) {
        setNote("That file changed. Try again.");
        return;
      }
      setProposals((current) => (current ? current.filter((row) => row.id !== id) : current));
      const fromLog = waiting.some((row) => row.id === id);
      setWaiting((current) => current.filter((row) => row.id !== id));
      // An accepted edit changed Opinions. Read it again so the box does not show the old text.
      if (fromLog && kind === "accept") void loadRest();
    } catch (error) {
      setNote(message(error, "That could not be saved. Try again."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /**
   * Accept all or Reject all: each suggestion goes through the same accept or reject as a tap on
   * it, one after another, so every guard, size cap and rejection memory applies. One that is
   * refused stays in the list; the rest go on.
   */
  async function decideAll(kind: "accept" | "reject") {
    if (busyRef.current || !proposals || proposals.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    const done: string[] = [];
    let refused = 0;
    let lastError = "";
    try {
      for (const proposal of proposals) {
        try {
          const ok =
            kind === "accept" ? await portsRef.current.accept(proposal.id) : await portsRef.current.reject(proposal.id);
          if (ok) done.push(proposal.id);
          else refused += 1;
        } catch (error) {
          refused += 1;
          lastError = message(error, "");
        }
      }
      setProposals((current) => (current ? current.filter((row) => !done.includes(row.id)) : current));
      const verb = kind === "accept" ? "Accepted" : "Rejected";
      if (refused === 0) setNote(`${verb} ${done.length}.`);
      else {
        const tail = lastError ? ` ${lastError}` : "";
        setNote(`${verb} ${done.length}. ${refused} could not be saved and ${refused === 1 ? "is" : "are"} still listed.${tail}`);
      }
      if (kind === "accept" && done.length > 0) void loadRest();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function onWeekly(next: boolean) {
    if (busyRef.current) return;
    const previous = weekly;
    setWeekly(next);
    try {
      const ok = await portsRef.current.setWeekly(next);
      if (!ok) {
        setWeekly(previous);
        setNote("That could not be saved. Try again.");
      }
    } catch (error) {
      setWeekly(previous);
      setNote(message(error, "That could not be saved. Try again."));
    }
  }

  async function save(which: "opinions" | "voice") {
    if (busyRef.current || !profiles) return;
    const text = which === "opinions" ? opinions : voice;
    const sha = which === "opinions" ? profiles.opinionsSha256 : profiles.voiceSha256;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const ok = await portsRef.current.saveProfile(which, text, sha);
      if (!ok) {
        setNote("That file changed. Try again.");
        const next = await portsRef.current.loadProfiles();
        setProfiles(next);
        setOpinions((typed) => textAfterLoad(typed, opinionsDirty.current, next.opinions));
        setVoice((typed) => textAfterLoad(typed, voiceDirty.current, next.voice));
        return;
      }
      const next = await portsRef.current.loadProfiles();
      setProfiles(next);
      if (which === "opinions") {
        setOpinions((typedNow) => {
          const kept = textAfterSave(typedNow, text, next.opinions);
          opinionsDirty.current = kept.dirty;
          return kept.text;
        });
        setVoice((typed) => textAfterLoad(typed, voiceDirty.current, next.voice));
      } else {
        setVoice((typedNow) => {
          const kept = textAfterSave(typedNow, text, next.voice);
          voiceDirty.current = kept.dirty;
          return kept.text;
        });
        setOpinions((typed) => textAfterLoad(typed, opinionsDirty.current, next.opinions));
      }
    } catch (error) {
      setNote(message(error, "That could not be saved. Try again."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const due = schedule ? weeklyDue(schedule, now()) : false;

  function renderProposal(proposal: ShownProposal) {
    return (
      <article key={proposal.id} data-proposal={proposal.id} className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{proposal.title}</h3>
        <pre className="overflow-auto text-xs">{proposal.diff}</pre>
        {proposal.quotes.map((quote, index) => (
          <blockquote key={`${quote.sessionId}-${index}`} className="text-sm">
            {quote.quote}
          </blockquote>
        ))}
        {proposal.note ? <p className="text-sm">{proposal.note}</p> : null}
        <div className="flex gap-2">
          <button type="button" className={BTN} disabled={busy} onClick={() => void decide(proposal.id, "accept")}>
            Accept {proposal.title}
          </button>
          <button type="button" className={BTN} disabled={busy} onClick={() => void decide(proposal.id, "reject")}>
            Reject {proposal.title}
          </button>
        </div>
      </article>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Learn from chats">
      <p className="text-sm">Instruction files stay under 2,000 tokens. Each profile file stays under 1,500.</p>
      {cost !== null && estimate ? (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            {estimate.chats === 0
              ? "No chats to read yet."
              : `This reads ${estimate.chats} ${estimate.chats === 1 ? "chat" : "chats"}, about ${formatTokens(cost)} tokens${estimate.model ? `, with ${estimate.model}` : ""}.`}{" "}
            Nothing is saved until you accept an edit.
          </p>
          {estimate.leftOut > 0 || estimate.tooBig > 0 ? (
            <p>
              {estimate.leftOut > 0 ? `${formatTokens(estimate.leftOut)} older chats were left out. ` : ""}
              {estimate.tooBig > 0
                ? `${formatTokens(estimate.tooBig)} ${estimate.tooBig === 1 ? "chat was" : "chats were"} too big to read.`
                : ""}
            </p>
          ) : null}
        </div>
      ) : cost !== null ? (
        <p className="text-sm">
          This sends about {formatTokens(cost)} tokens. Nothing is saved until you accept an edit.
        </p>
      ) : null}
      {costFailed ? (
        <button type="button" className={BTN} onClick={() => void loadCost()}>
          Try again
        </button>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={weekly} onChange={(event) => void onWeekly(event.target.checked)} />
        Run once a week
      </label>
      {due || heldOffer ? <p className="text-sm">A weekly look is ready.</p> : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeUser}
          onChange={(event) => setIncludeUser(event.target.checked)}
        />
        Include my instruction file
      </label>
      <button type="button" className={BTN} disabled={busy || cost === null} onClick={() => void onRun()}>
        Learn from recent chats
      </button>
      {note ? <p className="text-sm">{note}</p> : null}
      {waiting.length > 0 ? (
        <section aria-label="From the work log" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">From the work log</h3>
          <p className="text-sm">A retro suggested these. Nothing is saved until you accept one.</p>
          {waiting.map((proposal) => renderProposal(proposal))}
        </section>
      ) : null}
      {proposals && proposals.length > 0 ? (
        <section aria-label="Suggested rules" className="flex flex-col gap-2">
          <p className="text-sm" data-testid="learn-batch-summary">
            {batchChats > 0
              ? `${proposals.length} suggested ${proposals.length === 1 ? "rule" : "rules"} from ${batchChats} ${batchChats === 1 ? "chat" : "chats"}`
              : `${proposals.length} suggested ${proposals.length === 1 ? "rule" : "rules"}`}
          </p>
          <div className="flex gap-2">
            <button type="button" className={BTN} disabled={busy} onClick={() => void decideAll("accept")}>
              Accept all
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={() => void decideAll("reject")}>
              Reject all
            </button>
          </div>
          {proposals.map((proposal) => renderProposal(proposal))}
        </section>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        Opinions
        <textarea
          aria-label="Opinions"
          value={opinions}
          disabled={!profiles}
          onChange={(event) => {
            opinionsDirty.current = true;
            setOpinions(event.target.value);
          }}
          className="min-h-24 rounded-md border border-content/15 bg-transparent px-2 py-1"
        />
      </label>
      <button type="button" className={BTN} disabled={busy || !profiles} onClick={() => void save("opinions")}>
        Save opinions
      </button>
      <label className="flex flex-col gap-1 text-sm">
        Voice
        <textarea
          aria-label="Voice"
          value={voice}
          disabled={!profiles}
          onChange={(event) => {
            voiceDirty.current = true;
            setVoice(event.target.value);
          }}
          className="min-h-24 rounded-md border border-content/15 bg-transparent px-2 py-1"
        />
      </label>
      <button type="button" className={BTN} disabled={busy || !profiles} onClick={() => void save("voice")}>
        Save voice
      </button>
    </section>
  );
}
