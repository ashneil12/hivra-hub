// Renders one label.
//
// The starting state is wrong: it outputs "beta" for "x", which PROTECTED.md forbids.
export function render(input) {
  return input === "x" ? "beta" : input;
}
