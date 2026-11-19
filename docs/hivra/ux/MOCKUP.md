# The design mockup

A clickable copy of the real app for design and UX review: the real frontend, built to static files, every native call
stubbed (`src/dev/browserTauriMock.ts`) and an example dataset seeded first (`src/dev/mockup/`). Nothing is wired:
chats answer with a fixed line from the fake Claude, nothing reaches a disk, a CLI, a key or the network, and no real
chat is ever in it (this repo is public).

```bash
npm run mockup:build          # target/mockup/: mockup.html + assets/, and page.html (the same page as a fragment)
npx vite --mode mockup        # or look at it live with HMR: http://localhost:1420/mockup.html
```

- The example data is in `src/dev/mockup/data.ts`: four projects, a Chief of Staff, a lead per project, two crew Monos,
  their chats, nine workers (working, stopped, done) and decisions (open, and decided by the Chief of Staff).
- The page seeds once per `SEED_VERSION` (seed.ts) and keeps what was clicked; `?reset` starts it over.
- To show screens that are still in open pull requests, build from a local merge of main and those branches; the
  mockup files themselves only need main.
- `page.html` is for a host that wraps a page in its own skeleton (a claude.ai Artifact): publish it with
  `assets/*` and `monocode.png` beside it. The build groups the lazy language and diagram chunks so there are about
  200 files, and writes ASCII only.
