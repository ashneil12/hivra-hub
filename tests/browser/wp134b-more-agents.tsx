// WP-134b: the More agents setting, on its own page.
import { createRoot } from "react-dom/client";
import { MoreAgentsSettings } from "../../src/features/registry/ui/MoreAgentsSettings";
import "../../src/styles/index.css";

createRoot(document.getElementById("root")!).render(<MoreAgentsSettings />);
