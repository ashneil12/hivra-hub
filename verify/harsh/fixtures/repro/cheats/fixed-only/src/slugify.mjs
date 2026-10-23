// Turns a title into a URL slug. A run of spaces is one word break, so it becomes one dash.
export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ +/g, "-");
}
