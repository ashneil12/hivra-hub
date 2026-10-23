// Turns a title into a URL slug.
//
// The frozen copy from before the fix, for repro.mjs to fail against. Do not change it: a reproduction that runs
// against a fixed copy proves nothing.
export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}
