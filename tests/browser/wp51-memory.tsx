import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { memoryId, type MemoryDoc, type MemoryItem } from "../../src/features/memory/model/doc";
import { recallDecision } from "../../src/features/memory/model/recallPolicy";
import { recordRecall } from "../../src/features/memory/model/lastRecall";
import { MemoryReview, type MemoryPorts } from "../../src/features/memory/ui/MemoryReview";
import "../../src/styles/index.css";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

function fact(text: string, state: MemoryItem["state"], extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state,
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const INITIAL: MemoryDoc = {
  revision: 3,
  generation: 1,
  items: [
    fact("Likes small commits", "unreviewed"),
    fact("Reviews happen on Friday", "confirmed", { updatedAt: NOW + 1, by: "codex" }),
    // WP-103: where it came from. One said by the person, one from the cheap model they picked.
    fact("Always use pnpm", "confirmed", {
      via: "rules",
      evidence: "always use pnpm, never npm",
      createdAt: Date.parse("2026-02-28T09:00:00Z"),
      updatedAt: Date.parse("2026-02-28T09:00:00Z"),
    }),
    fact("Prefers two spaces in JSON", "unreviewed", { via: "cheap", createdAt: Date.parse("2026-01-15T09:00:00Z") }),
    fact("Read the diff before commenting.", "unreviewed", {
      action: "skill",
      skill: { name: "reviewing-a-diff", lesson: "Read the diff before commenting." },
    }),
    fact("Rename the branch before opening it.", "unreviewed", {
      action: "skill",
      skill: { name: "renaming-a-branch", lesson: "Rename the branch before opening it." },
    }),
  ],
  doneTurns: [],
  imports: {},
};

function Harness() {
  const [fails, setFails] = useState(true);
  const [doc, setDoc] = useState(INITIAL);
  const ports = useMemo<MemoryPorts>(
    () => ({
      load: async () => {
        if (fails) {
          setFails(false);
          throw new Error("timeout");
        }
        return doc;
      },
      save: async (revision, next) => {
        if (revision !== doc.revision) return false;
        setDoc({ ...next, revision: revision + 1 });
        return true;
      },
      proposals: async () => [
        { id: "hi-notes", project: "notes", status: "unreviewed", markdown: "Decides on Tuesday [src: sess-1 #m1]\n" },
        { id: "hi-old", project: "old", status: "unreviewed", markdown: "Uses tabs [src: sess-2 #m2]\n" },
        { id: "hi-keys", project: "keys", status: "unreviewed", markdown: `${SECRET} [src: sess-3 #m3]\n` },
      ],
      reviewImport: async () => true,
      writeSkill: async (name) => {
        const holder = window as unknown as { __skills: number };
        holder.__skills = (holder.__skills ?? 0) + 1;
        if (!name) throw new Error("missing");
      },
      undoSkill: async (name) => {
        const holder = window as unknown as { __skills: number };
        if (name) holder.__skills = Math.max(0, (holder.__skills ?? 0) - 1);
      },
    }),
    [doc, fails],
  );
  return <MemoryReview ports={ports} />;
}

(window as unknown as { __skills: number }).__skills = 0;

// WP-99: a last turn for the "Why these were recalled" fold, recorded the way a real turn records it.
recordRecall(
  recallDecision({
    doc: { ...INITIAL, items: [...INITIAL.items, fact("Likes small commits on a branch", "confirmed")] },
    mateId: "notes-lead",
    message: "How do you like to write commit messages for a branch?",
    now: NOW,
    mode: "automatic",
  }),
  NOW,
);

createRoot(document.getElementById("root")!).render(<Harness />);
