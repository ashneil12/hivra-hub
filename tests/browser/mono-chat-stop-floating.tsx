import "./macPlatform";
import { createRoot } from "react-dom/client";
import { FloatingMonoChat } from "../../src/features/monos/ui/FloatingMonoChat";
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

// The pop-out chat's own webview (mono-chat.html / floatingMain.tsx), with its IPC sent to the fixture's relay in the
// main window's frame: nothing else is shared, as with the real windows.
type Native = {
  attach(emit: (event: string, payload: unknown) => void): void;
  invoke(command: string, args: Record<string, unknown>): unknown;
};
const native = (window.parent as unknown as { monoChatNative: Native }).monoChatNative;
document.documentElement.classList.add("is-mac");
const bus = installFakeTauri("mono-chat:vg-game-lead", (command, args) => native.invoke(command, args));
createRoot(document.getElementById("root")!).render(<FloatingMonoChat onShown={() => {}} />);
native.attach(bus.emit);
