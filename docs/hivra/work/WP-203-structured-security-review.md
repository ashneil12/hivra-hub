# WP-203: A structured hard review for security-sensitive packages

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M (overnight suggestion, parked for Ash) | M | WP-81 (delivery gate, on main), WP-160 (never-merge list, on main); WP-144 shares the reviewer spawn | no |

## Goal

A security-sensitive change (the secret vault, remote access, phone pairing, approvals, plugin installs) gets a
recorded review by a builder that did not write it. The review is structured: a coverage ledger of what was read,
candidate findings each checked by a fresh verifier, and a findings file that a schema validator accepts. The merge
gate reads that file for the exact head being merged.

## Why

The rule from 10 Nov 2026 is that security packages merge only after a hard review by a different builder finds no
high or critical issue. Today that review is a free-form prompt, so "what was checked" lives only in the reviewer's
reply.

Cloudflare's `security-audit-skill` (MIT, github.com/cloudflare/security-audit-skill) gives the missing structure:
isolated hunters working from a coverage ledger; each candidate sent to a fresh verifier that tries to disprove it;
`confirmed`, `needs_validation` and `rejected` records in `findings.json` checked against a schema; and two
zero-dependency validators. Its reference notes for desktop and local IPC, supply chain and AI agents match Hivra's
risk surface (a Tauri app with local listeners, plugin installs, agent tools). Runs are additive: a second run
targets gaps and changed source.

## Read first

- The skill's own README and reference files, read in a scratch folder and deleted after the read.
- WP-81 (the gate before GitHub), WP-144 (the zero-context review of a plan, a different reviewer job; keep the two
  apart), and WP-160's `model/neverMerge.json` (the list of never-merge packages).
- WP-92, WP-150 and WP-158 as the first real inputs (their briefs name them as security-park).

## Build

1. **Vendor the reference and validators.** Copy the skill's reference files and the two validators
   (`validate-findings.cjs`, `validate-coverage-ledger.cjs`) into `scripts/security-review/` with the MIT notice and
   a credit line. Nothing is installed into the user's Claude config folder. Test: the validators pass a good fixture and reject a
   malformed one (a negative control, so a broken validator cannot pass everything).
2. **Different builder.** A review run records the author builder and the reviewer builder for the change. The same
   builder, or a missing author record, is refused with a plain line. Test: same builder refused; different builder
   allowed; unknown author refused.
3. **Scoped to the diff.** The run reviews the changed files of one PR (or a named path list), not the whole repo. A
   diff over a file cap is refused with a plain line saying how to narrow it. Test: a fixture of 3 files runs; a
   fixture over the cap is refused; no file outside the diff is read.
4. **Verify each candidate.** Every candidate is sent to a fresh verifier with no shared context, which tries to
   disprove it. Results are `confirmed`, `needs_validation` or `rejected`, written to `findings.json` for the head SHA.
   Test: a candidate the fake verifier rejects does not block; a confirmed high does; the file records the SHA.
5. **Merge gate.** A security-sensitive PR (its path matches the list, or it has the security-park label) cannot merge
   while there is a confirmed high or critical finding for that head, or no findings file for that exact head. A
   `needs_validation` item adds one line to the Inbox and does not block. The path list is shared with
   `neverMerge.json`, not copied. Test: stale head refused; confirmed high refused; `needs_validation` adds one Inbox
   line and passes; a clean file passes; a non-security path skips the gate.
6. **Cost.** Reviewers run on the cheap worker default through the gateway, never on the lead's own subscription, and
   the run prints its file count and approximate size before it starts. Test: the run plan uses the worker default
   and shows the count.
7. **Dry run on real code.** Run once on the WP-92 vault diff in a dev copy and attach the findings file and both
   validator outputs to the PR. This is a read-only proof, not a merge.

## Done when

- [ ] Tests for steps 1 to 6 pass, with the negative controls; `npm run check` is green.
- [ ] A planted high-severity issue on a throwaway branch is blocked by the gate (the negative control in a dev copy).
- [ ] The step 7 dry run is attached to the PR, with the validators' output.
- [ ] Reviewed by a builder that did not write it, with no high or critical finding.

## Out of scope

- Any remote or cloud reviewer. Reviewers run locally, as WP-144 requires.
- Auto-fixing findings. A finding goes to a builder or to the person.
- Changing the approval UI, the never-merge list's contents, or WP-144 and WP-81.
- Whole-repo scans on every run.

## Licence

Cloudflare `security-audit-skill`, MIT. Copy the notice with the vendored files, and add a `SOURCES.md` row, a
`NOTICE` entry and a `credits.json` entry when the files land.

## Sources

- https://github.com/cloudflare/security-audit-skill (MIT)
- https://blog.cloudflare.com/build-your-own-vulnerability-harness
- Overnight scout suggestion, 10 Nov 2026 (structured review, not yet queued).
