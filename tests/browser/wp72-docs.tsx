import { createRoot } from "react-dom/client";
import { memoryGateway } from "../../src/features/docs/gateway";
import { DocsScreen } from "../../src/features/docs/ui/DocsScreen";
import type { MentionTarget } from "../../src/features/docs/model/types";
import "../../src/styles/index.css";

const catalog: MentionTarget[] = [{ kind: "task", id: "task-1", name: "Write the spec" }];

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <DocsScreen
      cwd="/tmp/project"
      onClose={() => {}}
      gateway={memoryGateway({ catalog })}
      catalog={catalog}
      idleMs={200}
    />,
  );
}
