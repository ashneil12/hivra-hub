# Make the warning banner readable

`page.html` shows a warning banner above a Save button. Two things are wrong with it:

- The banner's text is hard to read: it is too low-contrast against its own background. Make the text at
  least 4.5:1 against the background it actually sits on.
- The banner overlaps the Save button. Move it so the two do not overlap.

Keep both elements: the banner (`[data-banner]`) and the Save button (`[data-save]`). This is a visual change:
it has to be looked at, not just reasoned about.
