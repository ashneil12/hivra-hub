// Runs before any app module reads local storage (imported first by pm-ui-ideas.tsx).
// Example data only: Ada's chat, and the EXO lead so its reports name the EXO coding team.
localStorage.clear();
localStorage.setItem(
  "monocode:mono-roster",
  JSON.stringify([
    { id: "ada", name: "Ada", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", sessionId: "cos-chat", projects: [] },
    { id: "vg-game-lead", name: "EXO lead", mascot: "invader", color: "hsl(211 92% 62%)", sessionId: "exo-lead-chat", projects: ["/code/vg-game"] },
  ]),
);
localStorage.setItem(
  "monocode:hub-project-leads",
  JSON.stringify([{ projectId: "vg-game", id: "vg-game-lead", name: "EXO lead", projectName: "EXO" }]),
);
export {};
