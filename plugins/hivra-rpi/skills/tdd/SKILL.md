---
name: tdd
description: "The first mate runs this phase by name. Write the failing test first, then the change that makes it pass."
disable-model-invocation: true
---

The first mate runs this phase.

When the task asks for a test first, write the smallest test that fails for the reason the task describes. Run it and see it fail. Then make the smallest change that makes it pass, and run it again.

Do not write the change first. If there is no honest way to run a test, say so and stop, rather than inventing a test that cannot fail.
