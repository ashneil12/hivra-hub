// WP-242: Settings > Memory with the "Learn skills" switch under how Hivra remembers, and the health card counting
// lessons left out while learning is off. Example data only. `?before` renders the screen as it was, without the switch.

import { createRoot } from "react-dom/client";
import { emptyHealth, type MemoryHealthView } from "../../src/features/memory/model/health";
import { MemoryHealthCard } from "../../src/features/memory/ui/MemoryHealthCard";
import { MemoryTierSetting } from "../../src/features/memory/ui/MemoryTierChoice";
import { SkillLearningSetting } from "../../src/features/memory/ui/SkillLearningChoice";
import "../../src/styles/index.css";

const NOW = Date.parse("2026-11-01T09:00:00Z");
const before = new URLSearchParams(location.search).has("before");

const health: MemoryHealthView = {
  ...emptyHealth(),
  lastRunAt: NOW - 5 * 60_000,
  turns: 12,
  stored: 4,
  ...(before ? {} : { skillsDropped: 2 }),
  fading: 0,
  asksWaiting: 0,
};

function Harness() {
  return (
    <>
      <div className="mb-6">
        <MemoryTierSetting />
      </div>
      {before ? null : (
        <div className="mb-6">
          <SkillLearningSetting />
        </div>
      )}
      <MemoryHealthCard health={health} now={NOW} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
