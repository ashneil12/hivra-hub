# Tally

Tally is a tiny team habit counter: each person keeps a few tallies ("glasses of water", "pages read") and taps +1
during the day. The team sees a weekly board.

It is a small TypeScript monorepo with no dependencies to install for the API and the tests (Node 22 runs the
TypeScript directly):

| Package | What it is |
| --- | --- |
| `packages/shared` | The types every package uses (`Tally`, `Entry`, `Stats`) and input checks. |
| `packages/api` | A plain `node:http` server: list, create and bump tallies, and a stats endpoint. Data is a JSON file. |
| `packages/ui` | The React board (`App.tsx`) and the pure helpers it uses (`format.ts`). React is not installed; only the helpers are tested. |

```bash
npm test            # every package's tests (node --test with type stripping)
npm run api         # the API on http://localhost:4317 (TALLY_DATA=./data.json by default)
```

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/tallies` | Every tally, newest first |
| POST | `/tallies` | `{ "name", "owner" }` makes a tally (name 1-40 chars) |
| POST | `/tallies/:id/bump` | `{ "by"?: number }` adds an entry (default +1) |
| GET | `/tallies/:id/stats` | `{ total, days, mean, median, best }` over the tally's daily totals |

## The weekly board (requirement)

Every tally **resets weekly**, and the board shows **last week's total** next to this week's count. People should
**see how the team is doing**.

## Open decisions

- **Sharing (Ash decides):** can everyone on the team see everyone's tallies, or are tallies private unless shared?
  Ash hasn't picked. Do not build sharing until he does.

## Known problems

- `npm test` is red: one stats test fails.
- The UI keeps its own copy of the tally type instead of using `packages/shared`.
