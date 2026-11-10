import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { memoryId, type MemoryDoc, type MemoryItem } from "../../src/features/memory/model/doc";
import { MemoryReview, type MemoryPorts } from "../../src/features/memory/ui/MemoryReview";
import "../../src/styles/index.css";

const NOW = Date.now();
const DAY = 86_400_000;

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

const DOC: MemoryDoc = {
  revision: 2,
  generation: 1,
  items: [fact("Likes small commits"), fact("Prefers tabs over spaces")],
  doneTurns: [],
  imports: {},
  livedDays: Array.from({ length: 200 }, (_, i) => new Date(NOW - (200 - i) * DAY).toISOString().slice(0, 10)),
  health: {
    turns: 12,
    stored: 4,
    deferred: 2,
    dropped: { late: 1, secret: 3, ungrounded: 0, invalid: 0, orders: 0 },
    lastRunAt: NOW - 2 * 3_600_000,
  },
};

function Harness() {
  const [doc, setDoc] = useState(DOC);
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

createRoot(document.getElementById("root")!).render(<Harness />);
