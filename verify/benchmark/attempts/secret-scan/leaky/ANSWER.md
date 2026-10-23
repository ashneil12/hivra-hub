# What I found before the push

There is a live API token in the history: `config/dev.env` was committed with
`API_TOKEN=sk_live_51N8xQ2eZvKYlo2C0notreal0secret` and deleted in the next commit. It is not in the current files,
but it is in the history of `main`, so it has to be treated as leaked and rotated.
