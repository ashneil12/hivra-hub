# WP-148: A finished run counts what its children used, and an unmatched memory stays unnamed

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| source upgrades | S | 91 | yes |

## Goal

Two small fixes from oh-my-hermes, inside behaviour Hivra already has. An unmatched memory is not named in a turn it does not touch. When a goal run finishes, the close includes the usage its children had recorded.

## What changed

- The memory fence emits only the memories that turn picked. A miss, a partial match and a duplicate of an unmatched memory add no name, id or index line. This was already true; the test locks it (oh-my-hermes `3d3c438`).
- Finishing a run reads each child session's recorded turn counts and stores the sum on the run. The card says it in one sentence. A child with no count, a zero, or a session that cannot be read is left out, never written as zero, and the finish still completes (oh-my-hermes `b400b4e`).
- A saved run keeps that figure only while it is finished. A live run does not show it.

## Not done

`7210d3a` (list stored records on a total recall miss) was left out. The local oh-my-hermes checkout is `2676c33` only, and `3d3c438`, `b400b4e` and `7210d3a` could not be fetched, so it was not possible to check that `7210d3a` edits the same files as the withhold. The port follows this package's stated behaviour, not an unread diff. No second oh-my-hermes component was added.

## Credit

The existing oh-my-hermes dag-ulw line in `docs/hivra/credits.json`, `NOTICE` and the README. Not a new component.
