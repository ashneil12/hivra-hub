# Structure Outline: Archive a tally instead of deleting it

**Task:** `tally-archive`
**Repository:** `tally` at `bd8ef34` (branch `main`, clean working tree)
**Date:** 2026-11-05
**Inputs:** the task text and the completed research from the previous phase. No artifact directory exists, so the research output was its reply; its findings are carried into this outline.

## Implementation Overview

- [ ] Phase 1: Delete archives a tally and removes it from the board
- [ ] Phase 2: Archived tallies can be listed and restored

## The task describes a delete the code does not have

`DELETE /tallies/:id` does not exist. `route()` recognizes only `GET /tallies`, `POST /tallies`, `POST /tallies/:id/bump`, and `GET /tallies/:id/stats` (`packages/api/src/server.ts:24-41`); every other method on a known tally falls through to `405` (`server.ts:42`), and `DELETE` is still backlog item 2 (`TODO.md:4`). So this work introduces the delete route with archive semantics. There is no destructive handler to replace and no prior delete response shape to preserve.

"Keep the existing API shape working" therefore means the four existing routes keep their current bare-array/bare-object responses and status codes:

| Request | Behaviour after this work |
| --- | --- |
| `GET /tallies` | `200`, bare array of **active** tallies, newest first — same shape as today |
| `POST /tallies` | `201`, bare tally — unchanged |
| `POST /tallies/:id/bump` | `200`, bare tally for an active tally; `404` if the tally is archived |
| `GET /tallies/:id/stats` | `200`, bare `Stats` for an active tally; `404` if the tally is archived |
| `GET /tallies/:id` | `405 method not allowed` — unchanged |
| `DELETE /tallies/:id` | **new:** `200`, the archived tally; repeat deletes stay `200` |
| `POST /tallies/:id/restore` | **new:** `200`, the restored tally; repeat restores stay `200` |
| `GET /tallies?archived=true` | **new:** `200`, bare array of archived tallies only |

There is no aggregate stats surface anywhere in the codebase. The only place the API can "ignore archived tallies" is the per-tally stats route, so an archived tally's stats request becomes a `404`, the same response as a missing tally.

### Decisions this outline makes

| Decision | Choice | Why |
| --- | --- | --- |
| How "archived" is stored | `archivedAt?: string` on `Tally` | A timestamp records when, and an absent field means active. Existing `data.json` rows have no field and load as active without a migration. |
| Delete response | `200` with the archived tally | Matches bump returning a bare tally; lets the board update its list without a refetch. `204` would also be reasonable but gives the client nothing back. |
| Restore route | `POST /tallies/:id/restore` | Follows the existing `:id/bump` and `:id/stats` sub-route style. |
| Listing archived tallies | `GET /tallies?archived=true` | Keeps the default `GET /tallies` response byte-compatible for existing clients while giving the restore UI a way to discover ids. |
| Archived tallies and by-id routes | `404` for bump and stats | "Stats should ignore archived tallies," and an archived tally should be indistinguishable from a missing one on active surfaces. |
| Idempotency | Repeat delete or restore returns `200` | Archive/restore are state assignments, not one-shot operations; a retry after a dropped response should not fail. |

## Before Phase 1: make the suite green

`npm test` is red before any archive work: `median([1, 2, 3, 10])` is expected to be `2.5` (`packages/api/test/stats.test.ts:16-18`) but `median()` returns the upper-middle `3` (`packages/api/src/stats.ts:13-18`). This is already tracked as backlog item 1 and a known problem in the README. Fixing it is a one-line prerequisite so the test suite can gate both phases:

```diff
 export function median(values: number[]): number {
   if (values.length === 0) return 0;
   const sorted = [...values].sort((a, b) => a - b);
   const middle = Math.floor(sorted.length / 2);
-  return sorted[middle];
+  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
 }
```

The existing test is the verification; no new test is needed. If you want the archive change to stay pure, land this fix as its own commit first.

## Phase 1: Delete archives a tally and removes it from the board

### Overview

Add the lifecycle marker to the shared type, teach the store to archive and to hide archived tallies from its normal list, add `DELETE /tallies/:id`, and make the board row offer an Archive button. The board automatically stops showing the tally because it renders whatever `GET /tallies` returns, and that endpoint now returns active tallies only.

```text
packages/
├── shared/
│   └── src/
│       └── types.ts               # Tally gains archivedAt?: string
├── api/
│   ├── src/
│   │   ├── store.ts               # list() filters; archive() stamps archivedAt
│   │   └── server.ts              # DELETE route; archived rows 404 for bump/stats
│   └── test/
│       └── server.test.ts         # archive, hiding, idempotency, reload, 404s
└── ui/
    ├── src/
    │   ├── App.tsx                # Archive button drops the row
    │   └── format.ts              # toBoardTally() mapper extracted
    └── test/
        └── format.test.ts         # covers the mapper
```

The marker lives on the tally itself rather than in a second store or a side table. The store already reads and writes one `Tally[]`, so a single optional field keeps every read and write path working unchanged:

```diff
 export type Tally = {
   id: string;
   name: string;
   owner: string;
   createdAt: string;
   entries: Entry[];
+  /** ISO time the tally was archived. Missing means it is on the board. */
+  archivedAt?: string;
 };
```

`list()` is the only collection read, so that is where active tallies are separated from archived ones. `get()` stays as it is because restore must still be able to find an archived tally by id:

```diff
-  list(): Tally[] {
-    return [...this.tallies].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
+  list(archived = false): Tally[] {
+    return this.tallies
+      .filter((tally) => Boolean(tally.archivedAt) === archived)
+      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
   }
@@
+  archive(id: string, now = new Date()): Tally | undefined {
+    const tally = this.get(id);
+    if (!tally) return undefined;
+    if (!tally.archivedAt) {
+      tally.archivedAt = now.toISOString();
+      this.save();
+    }
+    return tally;
+  }
 
   bump(id: string, by: number, now = new Date()): Tally | undefined {
     const tally = this.get(id);
-    if (!tally) return undefined;
+    if (!tally || tally.archivedAt) return undefined;
```

The store's `bump` refuses archived tallies as a second line of defence; the route guard below is what turns that into a `404`.

The route adds delete before the existing bump/stats branches. Branch order matters: delete must be handled **before** the archived-tally guard so deleting an already-archived tally stays an idempotent `200` rather than falling into the invisible-tally `404`:

```diff
   const tally = parts[1] ? store.get(parts[1]) : undefined;
   if (!tally) return { status: 404, body: { error: "no such tally" } };
+  if (parts.length === 2 && method === "DELETE") return { status: 200, body: store.archive(tally.id) };
+  if (tally.archivedAt) return { status: 404, body: { error: "no such tally" } };
   if (parts[2] === "bump" && method === "POST") {
```

The resulting flow for a by-id request:

```text
/tallies/:id
  tally = store.get(id)
  if no tally                         -> 404 no such tally
  if DELETE /tallies/:id              -> 200 store.archive(id)
  if tally is archived                -> 404 no such tally   # bump and stats cannot see it
  if POST /:id/bump                   -> existing behaviour
  if GET  /:id/stats                  -> existing behaviour
  anything else                       -> 405
```

The board gains one control and loses one row:

```diff
+  const archive = async (id: string) => {
+    const res = await fetch(`${API}/tallies/${id}`, { method: "DELETE" });
+    if (res.ok) setTallies((rows) => rows.filter((row) => row.id !== id));
+  };
+
...
-            <button onClick={() => void bump(tally.id)}>+1</button>
+            <button onClick={() => void bump(tally.id)}>+1</button>
+            <button onClick={() => void archive(tally.id)}>Archive</button>
```

Because Phase 2 needs to turn both API responses back into board rows, pull the existing inline mapping in `App.tsx:13-21` into `format.ts`. This is the only UI piece that can be tested in this repository:

```diff
+export type ApiTally = {
+  id: string;
+  name: string;
+  owner: string;
+  entries: Array<{ by: number }>;
+};
+
+export function toBoardTally(row: ApiTally): BoardTally {
+  return {
+    id: row.id,
+    title: row.name,
+    owner: row.owner,
+    count: row.entries.reduce((sum, entry) => sum + entry.by, 0),
+  };
+}
```

`App.tsx` then uses `rows.map(toBoardTally)` in place of the inline object literal.

### Tests

`packages/api/test/server.test.ts` keeps its direct-`route()` style and its real temp-file `Store`. Split the existing helper so a test can reopen the same file:

```diff
+function freshDir(): string {
+  return fs.mkdtempSync(path.join(os.tmpdir(), "tally-"));
+}
 function freshStore(): Store {
-  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-"));
-  return new Store(path.join(dir, "data.json"));
+  return new Store(path.join(freshDir(), "data.json"));
 }
```

New route tests:

- **Delete archives and hides.** Create a tally, `DELETE /tallies/:id` returns `200` with a string `archivedAt`, and `GET /tallies` returns an empty array.
- **Archived tallies are invisible to bump and stats.** Both `POST /tallies/:id/bump` and `GET /tallies/:id/stats` return `404` after archiving.
- **Delete is idempotent and persists.** A second delete returns `200`; `store.list(true)` has one entry. A new `Store` constructed on the same file still reports `archivedAt` and `list()` still excludes it. This is the test that proves the marker survives serialization, because the store reads the file only at construction.
- **Unknown id is still a 404.** `DELETE /tallies/nope` returns `404`.
- **Board mapper.** In `packages/ui/test/format.test.ts`, `toBoardTally` maps `name` to `title` and sums all entry `by` values.

### Validation

#### Automated Verification

- [ ] `npm test` passes (the median prerequisite plus the new route and mapper tests).
- [ ] `node --experimental-strip-types --no-warnings --test packages/api/test/server.test.ts` passes on its own.
- [ ] No typecheck or lint script exists in this repository; the test suite and type stripping are the available gate. Do not invent a `tsc` command.

#### Manual Verification

- [ ] Run `TALLY_DATA=$(mktemp -d)/data.json npm run api`, create a tally with `curl`, delete it, and confirm `GET /tallies` no longer contains it while `GET /tallies/<id>/stats` and `POST /tallies/<id>/bump` both return `404`.
- [ ] Inspect the data file and confirm the row now has an `archivedAt` timestamp and all five original fields.
- [ ] The board cannot be launched in this checkout — there is no `node_modules` and no UI build script — so the button wiring is checked by reading `App.tsx`. If a React environment is available, archive a row and confirm it disappears without a page reload.

## Phase 2: Archived tallies can be listed and restored

### Overview

Add the read surface that makes restore possible, the restore operation itself, and an Archived section on the board. The default list stays active-only; the new query parameter returns the other half of the collection.

```text
packages/
├── api/
│   ├── src/
│   │   ├── store.ts               # restore() clears archivedAt
│   │   └── server.ts              # ?archived=true listing; POST /:id/restore
│   └── test/
│       └── server.test.ts         # archived listing, restore, idempotency, reload
└── ui/
    └── src/
        └── App.tsx                # Archived section with Restore buttons
```

`restore()` is the mirror of `archive()`. It does not create or move anything; clearing the optional field is enough for `list()` and the by-id guard to treat the tally as active again:

```diff
+  restore(id: string): Tally | undefined {
+    const tally = this.get(id);
+    if (!tally) return undefined;
+    if (tally.archivedAt) {
+      delete tally.archivedAt;
+      this.save();
+    }
+    return tally;
+  }
```

The route now needs the query string that the current implementation deliberately discards. It also needs restore to be reachable while the tally is archived, so that branch must sit before the archived-tally guard:

```diff
-  const parts = url.split("?")[0].split("/").filter(Boolean);
+  const [pathname, search = ""] = url.split("?");
+  const parts = pathname.split("/").filter(Boolean);
+  const archivedOnly = new URLSearchParams(search).get("archived") === "true";
@@
-  if (parts.length === 1 && method === "GET") return { status: 200, body: store.list() };
+  if (parts.length === 1 && method === "GET") return { status: 200, body: store.list(archivedOnly) };
@@
   const tally = parts[1] ? store.get(parts[1]) : undefined;
   if (!tally) return { status: 404, body: { error: "no such tally" } };
+  if (parts[2] === "restore" && method === "POST") return { status: 200, body: store.restore(tally.id) };
   if (parts.length === 2 && method === "DELETE") return { status: 200, body: store.archive(tally.id) };
   if (tally.archivedAt) return { status: 404, body: { error: "no such tally" } };
```

The board keeps two lists and moves a row between them on each successful call. The existing fetch becomes a pair of fetches, and the archive handler now keeps the returned row instead of discarding it:

```diff
   const [tallies, setTallies] = useState<BoardTally[]>([]);
+  const [archived, setArchived] = useState<BoardTally[]>([]);
 
   useEffect(() => {
-    void fetch(`${API}/tallies`)
-      .then((res) => res.json())
-      .then((rows) => setTallies(rows.map(toBoardTally)));
+    void Promise.all([
+      fetch(`${API}/tallies`)
+        .then((res) => res.json())
+        .then((rows) => setTallies(rows.map(toBoardTally))),
+      fetch(`${API}/tallies?archived=true`)
+        .then((res) => res.json())
+        .then((rows) => setArchived(rows.map(toBoardTally))),
+    ]);
   }, []);
@@
   const archive = async (id: string) => {
     const res = await fetch(`${API}/tallies/${id}`, { method: "DELETE" });
-    if (res.ok) setTallies((rows) => rows.filter((row) => row.id !== id));
+    if (!res.ok) return;
+    const row = toBoardTally(await res.json());
+    setTallies((rows) => rows.filter((r) => r.id !== id));
+    setArchived((rows) => [...rows, row]);
   };
+
+  const restore = async (id: string) => {
+    const res = await fetch(`${API}/tallies/${id}/restore`, { method: "POST", body: "{}" });
+    if (!res.ok) return;
+    const row = toBoardTally(await res.json());
+    setArchived((rows) => rows.filter((r) => r.id !== id));
+    setTallies((rows) => [...rows, row]);
+  };
```

The Archived section reuses `boardOrder()` because archived rows carry the same `count`; a collapsed `<details>` block keeps it out of the way of the board:

```tsx
<details>
  <summary>Archived ({archived.length})</summary>
  <ul>
    {boardOrder(archived).map((tally) => (
      <li key={tally.id}>
        <strong>{tally.title}</strong> ({tally.owner})
        <button onClick={() => void restore(tally.id)}>Restore</button>
      </li>
    ))}
  </ul>
</details>
```

### Tests

New route tests in `packages/api/test/server.test.ts`:

- **Archived listing is separate.** After archiving one tally, `GET /tallies` is empty and `GET /tallies?archived=true` has exactly that tally. A second, active tally appears only in the default list.
- **Restore puts it back.** `POST /tallies/:id/restore` returns `200` with no `archivedAt`; the default list contains it again and the archived list is empty.
- **Restore is idempotent.** Restoring an already-active tally returns `200` and does not create a duplicate or change its entries.
- **Restore of an unknown id is a 404.**
- **Restore persists.** A new `Store` on the same file reports the tally as active and `list(true)` is empty.

No new format test is needed; Phase 1's `toBoardTally` test already covers the shape both lists use.

### Validation

#### Automated Verification

- [ ] `npm test` passes with the Phase 1 and Phase 2 tests together.
- [ ] `node --experimental-strip-types --no-warnings --test packages/api/test/server.test.ts` passes on its own.

#### Manual Verification

- [ ] With the API running against a temp data file, create and delete a tally, confirm `GET /tallies?archived=true` returns it, `POST /tallies/<id>/restore` returns it without `archivedAt`, and `GET /tallies` contains it again.
- [ ] Confirm an archived tally remains `404` for bump and stats until it is restored, then works normally.
- [ ] The React board still cannot be launched in this checkout; review the two-state wiring by reading `App.tsx`. If a React environment is available, archive a row, open Archived, and restore it.

## Open questions

These are the decisions the code and task text do not settle. The outline chooses defaults so implementation can proceed; each is cheap to change.

1. **Delete response shape.** This plan returns `200` with the archived tally. If an existing external client expects `204 No Content`, change only the `DELETE` branch's return value.
2. **Restore path.** This plan uses `POST /tallies/:id/restore`. `POST /tallies/:id/unarchive` or a `PATCH` on the tally would also fit; the store method does not care.
3. **How archived tallies are discovered.** This plan adds `GET /tallies?archived=true`, returning archived tallies only. An `?includeArchived=true` variant returning both collections would avoid two fetches but changes what the default-shaped endpoint does for that caller.
4. **By-id visibility of archived tallies.** This plan makes bump and stats return `404`, so archived tallies are indistinguishable from missing ones. If viewing an archived tally or its stats before restoring is desirable, drop the `if (tally.archivedAt)` guard for the relevant branch.
5. **UI scope.** The repository's board had no delete control, archived view, or restore control. This plan adds Archive and Restore buttons because the task talks about the board and about people wanting tallies back. If the intended scope is API-only, delete the UI hunks from both phases; the server-side `list()` filter already removes archived tallies from the existing board.
6. **Idempotency.** Repeat delete and repeat restore both return `200`. If a client should learn that nothing changed, `409 Conflict` is the alternative.
7. **Retention.** Archived tallies stay in `data.json` forever; this plan adds no purge or retention endpoint. Confirm that unbounded growth is acceptable.
8. **The median fix.** It is unrelated to archiving but required for `npm test` to gate the work. If the team wants the archive change landable on its own, fix the median in a separate commit first.