import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { memoryId, type MemoryDoc, type MemoryItem } from "../../src/features/memory/model/doc";
import { MemoryReview, type MemoryPorts } from "../../src/features/memory/ui/MemoryReview";
import "../../src/styles/index.css";

const NOW = Date.now();

function fact(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const SKILL = fact("Read the diff before commenting.", {
  action: "skill",
  skill: { name: "reviewing-a-diff", lesson: "Read the diff before commenting." },
});

type Holder = { __doc: MemoryDoc; __files: Record<string, string>; __refuse: boolean };
const holder = window as unknown as Holder;

function startDoc(): MemoryDoc {
  return { revision: 1, generation: 1, items: [SKILL, fact("Likes small commits")], doneTurns: [], imports: {} };
}

function Harness() {
  const [doc, setDoc] = useState(startDoc);
  const [version, setVersion] = useState(0);
  holder.__doc = doc;
  const ports = useMemo<MemoryPorts>(
    () => ({
      load: async () => doc,
      save: async (revision, next) => {
        if (revision !== doc.revision) return false;
        setDoc({ ...next, revision: revision + 1 });
        return true;
      },
      proposals: async () => [],
      reviewImport: async () => true,
      writeSkill: async (name, lesson) => {
        holder.__files[name] = `- ${lesson}\n`;
        setVersion((v) => v + 1);
      },
      undoSkill: async (name, lesson) => {
        if (holder.__refuse) throw new Error("the folder is away");
        const text = holder.__files[name] ?? "";
        holder.__files[name] = text.replace(`- ${lesson}\n`, "");
        setVersion((v) => v + 1);
      },
    }),
    [doc, version],
  );
  return <MemoryReview ports={ports} />;
}

holder.__files = { "reviewing-a-diff": "- Read the diff before commenting.\n" };
holder.__refuse = false;
createRoot(document.getElementById("root")!).render(<Harness />);
