// Turns a title into a URL slug.
//
// The starting state is wrong: every space becomes its own dash, so a run of spaces becomes a run of dashes
// ("Hello  World" -> "hello--world").
export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}
