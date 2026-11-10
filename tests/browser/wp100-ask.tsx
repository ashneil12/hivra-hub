import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { memoryId, type MemoryDoc, type MemoryItem } from "../../src/features/memory/model/doc";
import { MemoryReview, type MemoryPorts } from "../../src/features/memory/ui/MemoryReview";
import "../../src/styles/index.css";

const NOW = Date.now();
const DAY = 86_400_000;

function livedDays(days: number): string[] {
  return Array.from({ length: days }, (_, i) => new Date(NOW - (days - i) * DAY).toISOString().slice(0, 10));
}

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
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 200 * DAY,
    fade: 0.05,
    lastUsedAt: NOW - 200 * DAY,
    ...extra,
  };
}

function startDoc(): MemoryDoc {
  return {
    revision: 3,
    generation: 1,
    items: [
      fact("Likes small commits"),
      fact("Reviews happen on Friday", { fade: 1, createdAt: NOW, updatedAt: NOW, lastUsedAt: NOW }),
      fact("Prefers tabs over spaces"),
    ],
    doneTurns: [],
    imports: {},
    livedDays: livedDays(200),
  };
}

type Holder = { __doc: MemoryDoc };
const holder = window as unknown as Holder;

function Harness() {
  const [doc, setDoc] = useState(startDoc);
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
      writeSkill: async () => undefined,
      undoSkill: async () => undefined,
    }),
    [doc],
  );
  return <MemoryReview ports={ports} />;
}

holder.__doc = startDoc();
createRoot(document.getElementById("root")!).render(<Harness />);
