// WP-129: the real short text setting, on its own.
import { createRoot } from "react-dom/client";
import { TextGenerationSetting } from "../../src/features/settings/ui/TextGenerationSetting";
import "../../src/styles/index.css";

createRoot(document.getElementById("root")!).render(<TextGenerationSetting />);
