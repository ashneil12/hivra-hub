// WP-240: the Memory screen with how sure each fact is, and its "Let go" tab. Example data only.

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { memoryId, type MemoryDoc, type MemoryItem } from "../../src/features/memory/model/doc";
import { MemoryReview, type MemoryPorts } from "../../src/features/memory/ui/MemoryReview";
import "../../src/styles/index.css";

const NOW = Date.parse("2026-11-01T09:00:00Z");

function fact(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state: "unreviewed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const KEPT_NOW = fact("Example: reviews happen on Friday", { state: "confirmed" });

const INITIAL: MemoryDoc = {
  revision: 1,
  generation: 1,
  items: [
    fact("Example: likes small commits"),
    fact("Example: writes release notes on Monday", { support: 2 }),
    KEPT_NOW,
  ],
  archived: [
    fact("Example: reviews happen on Thursday", {
      state: "confirmed",
      letGo: { reason: "superseded", by: KEPT_NOW.id, at: NOW - 3_600_000 },
    }),
    fact("Example: the trip to Lisbon is in October", {
      kind: "plan",
      validTo: "2026-10-31",
      letGo: { reason: "expired", at: NOW - 7_200_000 },
    }),
    fact("Example: prefers tabs", { letGo: { reason: "stale", at: NOW - 10_800_000 } }),
  ],
  doneTurns: [],
  imports: {},
};

function Harness() {
  const [doc, setDoc] = useState(INITIAL);
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
      writeSkill: async () => {},
      undoSkill: async () => {},
    }),
    [doc],
  );
  return <MemoryReview ports={ports} />;
}

createRoot(document.getElementById("root")!).render(<Harness />);
