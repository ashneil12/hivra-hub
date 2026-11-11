import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LearnFromChats, type LearnPorts, type LearnProfiles } from "../../src/features/memory/ui/LearnFromChats";
import "../../src/styles/index.css";

const NOW = Date.parse("2026-11-05T00:00:00.000Z");

const PROPOSALS = [
  {
    id: "p1",
    title: "Say it once",
    diff: "+ Say it once\n",
    quotes: [
      { sessionId: "one", quote: "the launch notes were wrong" },
      { sessionId: "two", quote: "the launch notes were wrong again" },
    ],
  },
  {
    id: "p2",
    title: "Drop the duplicate",
    diff: "- Drop the duplicate\n",
    quotes: [{ sessionId: "one", quote: "seen in two chats" }],
  },
];

// WP-157: what a work log retro left waiting, shown above the proposals from chats.
const WAITING = [
  {
    id: "retro:one",
    title: "Correction: Keep the work log line short.",
    diff: "+ ## Correction: Keep the work log line short.\n+ Keep the work log line short.",
    quotes: [{ sessionId: "work log 2026-11-10", quote: "Keep the work log line short." }],
    note: "Agents will see this once a second log line backs it.",
  },
  {
    id: "retro:two",
    title: "Work sent back",
    diff: "+ Work was sent back 2 times this week. Check the brief before the next try.",
    quotes: [
      { sessionId: "work log 2026-11-09", quote: "Sent back: The brief was wrong." },
      { sessionId: "work log 2026-11-10", quote: "Sent back: The brief was thin." },
    ],
  },
];

function Harness() {
  const [costFails, setCostFails] = useState(true);
  const profiles = useRef<LearnProfiles>({
    opinions: "# Opinions\n",
    voice: "# Voice\n\nUse this only when drafting something in this person's name.\n",
    opinionsSha256: "opinions-sha",
    voiceSha256: "voice-sha",
  });
  const ports = useMemo<LearnPorts>(
    () => ({
      cost: async () => {
        if (costFails) {
          setCostFails(false);
          throw new Error("timeout");
        }
        return 1200;
      },
      staged: async () => WAITING,
      run: async () => PROPOSALS,
      accept: async (id) => {
        const holder = window as unknown as { __accepted: string[] };
        holder.__accepted = [...(holder.__accepted ?? []), id];
        return true;
      },
      reject: async (id) => {
        const holder = window as unknown as { __rejected: string[] };
        holder.__rejected = [...(holder.__rejected ?? []), id];
        return true;
      },
      loadProfiles: async () => profiles.current,
      saveProfile: async (which, text, expectedSha256) => {
        const sha = which === "opinions" ? profiles.current.opinionsSha256 : profiles.current.voiceSha256;
        if (expectedSha256 !== sha) return false;
        profiles.current =
          which === "opinions"
            ? { ...profiles.current, opinions: text, opinionsSha256: "opinions-next" }
            : { ...profiles.current, voice: text, voiceSha256: "voice-next" };
        return true;
      },
      schedule: async () => ({ weekly: false, lastOfferedAt: null }),
      setWeekly: async (weekly) => weekly === true || weekly === false,
      markOffered: async () => true,
    }),
    [costFails],
  );
  return <LearnFromChats ports={ports} now={() => NOW} />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
