// Where the app opens. One decision, from a load that finished. A failed load never reaches this.

export function chooseOpening(input: { needsYou: number; navigated: boolean }): "home" | "stay" {
  if (input.navigated) return "stay";
  if (!Number.isFinite(input.needsYou) || input.needsYou <= 0) return "stay";
  return "home";
}
