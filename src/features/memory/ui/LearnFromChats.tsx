// WP-83: proposals from past chats, in the memory screen. Nothing is written here.
// The ports let a browser test drive it without Tauri.

import { useEffect, useRef, useState } from "react";
import type { Schedule } from "../backpass/schedule";
import { weeklyDue } from "../backpass/schedule";
import { formatTokens } from "../backpass/tokens";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export type ShownProposal = {
  id: string;
  title: string;
  diff: string;
  quotes: { sessionId: string; quote: string }[];
};

export type LearnProfiles = {
  opinions: string;
  voice: string;
  opinionsSha256: string;
  voiceSha256: string;
};

export type LearnPorts = {
  cost: () => Promise<number>;
  run: (input: { includeUserFile: boolean }) => Promise<ShownProposal[]>;
  accept: (id: string) => Promise<boolean>;
  reject: (id: string) => Promise<boolean>;
  loadProfiles: () => Promise<LearnProfiles>;
  saveProfile: (which: "opinions" | "voice", text: string, expectedSha256: string) => Promise<boolean>;
  schedule: () => Promise<Schedule>;
  setWeekly: (weekly: boolean) => Promise<boolean>;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function LearnFromChats({ ports, now = Date.now }: { ports: LearnPorts; now?: () => number }) {
  const [cost, setCost] = useState<number | null>(null);
  const [costFailed, setCostFailed] = useState(false);
  const [proposals, setProposals] = useState<ShownProposal[] | null>(null);
  const [profiles, setProfiles] = useState<LearnProfiles | null>(null);
  const [opinions, setOpinions] = useState("");
  const [voice, setVoice] = useState("");
  const [weekly, setWeekly] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [includeUser, setIncludeUser] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const portsRef = useRef(ports);
  portsRef.current = ports;

  async function loadCost() {
    try {
      const value = await portsRef.current.cost();
      if (!Number.isFinite(value) || value < 0) throw new Error("The cost could not be counted. Try again.");
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
      setOpinions(nextProfiles.opinions);
      setVoice(nextProfiles.voice);
      setSchedule(nextSchedule);
      setWeekly(nextSchedule.weekly === true);
    } catch (error) {
      setNote(message(error, "The profile could not be read. Try again."));
    }
  }

  useEffect(() => {
    void loadCost();
    void loadRest();
  }, []);

  async function onRun() {
    if (busyRef.current || cost === null) return;
    const ticket = generation.current + 1;
    generation.current = ticket;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const rows = await portsRef.current.run({ includeUserFile: includeUser });
      if (ticket !== generation.current) return;
      setProposals(rows);
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
    } catch (error) {
      setNote(message(error, "That could not be saved. Try again."));
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
        await loadRest();
        return;
      }
      const next = await portsRef.current.loadProfiles();
      setProfiles(next);
      setOpinions(next.opinions);
      setVoice(next.voice);
    } catch (error) {
      setNote(message(error, "That could not be saved. Try again."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const due = schedule ? weeklyDue(schedule, now()) : false;

  return (
    <section className="flex flex-col gap-4" aria-label="Learn from chats">
      <p className="text-sm">Instruction files stay under 2,000 tokens. Each profile file stays under 1,500.</p>
      {cost !== null ? (
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
      {due ? <p className="text-sm">A weekly look is ready.</p> : null}
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
      {proposals?.map((proposal) => (
        <article key={proposal.id} data-proposal={proposal.id} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{proposal.title}</h3>
          <pre className="overflow-auto text-xs">{proposal.diff}</pre>
          {proposal.quotes.map((quote, index) => (
            <blockquote key={`${quote.sessionId}-${index}`} className="text-sm">
              {quote.quote}
            </blockquote>
          ))}
          <div className="flex gap-2">
            <button type="button" className={BTN} disabled={busy} onClick={() => void decide(proposal.id, "accept")}>
              Accept {proposal.title}
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={() => void decide(proposal.id, "reject")}>
              Reject {proposal.title}
            </button>
          </div>
        </article>
      ))}
      <label className="flex flex-col gap-1 text-sm">
        Opinions
        <textarea
          aria-label="Opinions"
          value={opinions}
          onChange={(event) => setOpinions(event.target.value)}
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
          onChange={(event) => setVoice(event.target.value)}
          className="min-h-24 rounded-md border border-content/15 bg-transparent px-2 py-1"
        />
      </label>
      <button type="button" className={BTN} disabled={busy || !profiles} onClick={() => void save("voice")}>
        Save voice
      </button>
    </section>
  );
}
