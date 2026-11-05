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
    }),
    [costFails],
  );
  return <LearnFromChats ports={ports} now={() => NOW} />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
