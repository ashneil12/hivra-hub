import { createRoot } from "react-dom/client";
import { LiveAgentsPreview } from "../../src/features/sessions/ui/LiveAgentsPreview";
import { liveAgentsFromSessions } from "../../src/features/sessions/model/liveAgents";
import { newSession, sessionDisplayTitle, type Session } from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

// The Working tray (LiveAgentsPreview) on what the realtest baseline had: two workers running (one named by its chat's
// first line, the brief header), one finished and not yet seen. Before: the old rows; after: the Hub's rule (running
// work only) with each worker under its task title. Real component, real model; only the chats are made up here.
const now = Date.now();
const chat = (id: string, title: string, patch: Partial<Session>): Session => ({
  ...newSession("claude", "/p/tally"),
  id,
  title: `claude · ${title}`,
  blocks: [{ id: `${id}-u`, role: "user", text: "go", startedAt: now - 4 * 60_000, durationMs: 90_000 }],
  ...patch,
});
const sessions = [
  chat("delete", "[MonoCode brief from Chief of Staff]\n\nAsh said: \"hold on. make it work fully: deleting has to drop it from the board ui too\"", { busy: true }),
  chat("tz", "[MonoCode brief from Tally lead]\n\nCheck the weekly reset across time zones", { busy: true }),
  chat("stats", "Fix the red stats test", { busy: false }),
];
const finished = new Set(["stats"]);
const tasks: Record<string, string> = { delete: "Prove delete end to end, then review", tz: "Tally weekly reset timezone safety" };
// Before: every unseen finished chat stayed, under its chat's own title (the brief's first line).
const before = liveAgentsFromSessions(sessions, finished).map((agent) => ({
  ...agent,
  title: sessionDisplayTitle(sessions.find((s) => s.id === agent.id)!.title, "claude"),
}));
const after = liveAgentsFromSessions(sessions, finished, new Set(), { runningOnly: true, taskTitle: (id) => tasks[id] });
createRoot(document.getElementById("before")!).render(<LiveAgentsPreview agents={before} />);
createRoot(document.getElementById("after")!).render(<LiveAgentsPreview agents={after} />);
Object.assign(window, { tray: { before: before.map((a) => [a.title, a.done]), after: after.map((a) => [a.title, a.done]) } });
