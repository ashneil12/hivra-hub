# Fix `slugify` — and reproduce the bug first

`src/slugify.mjs` turns a title into a URL slug. It turns `"Hello  World"` (two spaces) into
`"hello--world"`; it should be `"hello-world"`. `node test.mjs` passes today because no test covers
the double space, so the suite does not show the bug.

1. Write `repro.mjs` in this folder that fails against the frozen, buggy copy at
   `before/src/slugify.mjs` and passes against `src/slugify.mjs` once it is fixed. It loads the copy
   it is given: `node repro.mjs --module before/src/slugify.mjs`, defaulting to `./src/slugify.mjs`.
2. Only then fix `src/slugify.mjs`.
3. Leave `before/` exactly as it is: it is the copy the reproduction proves the bug against.

`node test.mjs` must keep passing.
