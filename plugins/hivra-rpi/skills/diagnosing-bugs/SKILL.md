---
name: diagnosing-bugs
description: "The first mate runs this phase by name. Find the failing behavior before changing the code."
disable-model-invocation: true
---

The first mate runs this phase.

Name the bug before changing code. Write down what should happen, what happens instead, and the smallest way to see it again. Follow that path until the wrong behavior has a cause, and cite the file.

Do not start the fix in this phase. A guess with no reproduction is not a diagnosis. If the failing path cannot be run here, say what was tried and what is still unknown.
