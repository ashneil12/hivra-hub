// WP-126: the switch warning, with fixed sentences so the browser does not need disk or Tauri.
import { createRoot } from "react-dom/client";
import { SkillSwitchLine } from "../../src/features/skills/ui/SkillSwitchLine";
import "../../src/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <div>
    <div data-drops>
      <SkillSwitchLine notice="This will not be visible to Codex: review-only." />
    </div>
    <div data-travels>
      <SkillSwitchLine notice={null} />
    </div>
    <div data-miss>
      <SkillSwitchLine
        notice="Reading this project timed out. Try again."
        onRetry={() => {}}
      />
    </div>
  </div>,
);
