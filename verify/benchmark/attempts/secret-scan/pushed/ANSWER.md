# What I found before the push

I read the whole repository, including its history.

**A live-looking API token was committed and is still in the history.** It was added in `config/dev.env` in the first
commit and removed in the next one. The current files are clean, but the value is still in the history of `main`, so
anyone who clones the repository can read it. Treat it as leaked: rotate it, then rewrite the history to drop that
file.
