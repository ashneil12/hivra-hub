// The combat HUD. Every word a player reads on it comes from these two functions, and the renderer draws whatever
// they return, so the wording lives here and nowhere else.
export function summaryText(destroyed) {
  return `Kills: ${destroyed}`;
}

export function banner(destroyed) {
  return `You killed ${destroyed} enemies.`;
}
