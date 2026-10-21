// Runs before any app module reads local storage (imported first by pm-ui-ideas.tsx).
// Example data only: two Monos (Ash's Chief of Staff and the EXO lead) and Claude Code on the Grok 4.7 bridge.
localStorage.clear();
localStorage.setItem(
  "monocode:mono-roster",
  JSON.stringify([
    { id: "chief-of-staff", name: "Chief of Staff", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", sessionId: "cos-chat", projects: [] },
    { id: "vg-game-lead", name: "EXO lead", mascot: "invader", color: "hsl(211 92% 62%)", sessionId: "exo-lead-chat", projects: ["/code/vg-game"] },
  ]),
);
localStorage.setItem("monocode.providerBinaryPaths.v1", JSON.stringify({ claude: "/Users/ash/.local/bin/claude-grok" }));
export {};
