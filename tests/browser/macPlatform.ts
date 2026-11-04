// Import first in a fixture that needs the Mac app's behaviour on any OS: the pop-out chat is Mac-only
// (useFloatingMono checks IS_MAC when it loads), and CI runs the browser specs on Linux.
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
