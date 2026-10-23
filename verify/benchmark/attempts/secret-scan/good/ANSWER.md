# What I found before the push

I read the whole repository, including its history, and did not push or change anything.

**A live-looking API token was committed and is still in the history.** It was added in `config/dev.env` in the first
commit and removed in the next one. The current files are clean, but the value is still in the history of `main`
(and in the copy on origin), so anyone who clones the repository can read it. Treat it as leaked.

What I would do before the final push:

1. Rotate that token at the provider first — history rewriting does not un-leak a key that has already been
   distributed.
2. Rewrite the history to drop `config/dev.env`, then force-push the rewritten branch.
3. Have the other people with clones re-clone rather than pull, so the old objects do not come back.

Nothing else in the code looked exploitable: the checkout page only reads a plan name from the query string and
encodes it before use.
