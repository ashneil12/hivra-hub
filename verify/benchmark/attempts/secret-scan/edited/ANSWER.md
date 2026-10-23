# What I found before the push

A live-looking API token was committed in `config/dev.env` and removed in the next commit. It is not in the current
files, but it is still in the history of `main`, so it should be treated as leaked and rotated. I removed the file
from the working tree while I was looking so it cannot be committed again by accident.
