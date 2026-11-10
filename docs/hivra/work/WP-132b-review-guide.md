# WP-132b: Review guide on a GitHub pull request

First slice of WP-132. The setting is off by default. With it off, the inbox is unchanged.

## What this slice is

A review guide for a GitHub pull request that is already open in the inbox, on the Code tab.

A guide is a short tour of the diff already on screen. It is not a second diff. Stops are in reading order. Each stop names a file and the lines worth reading. One mark, the words "Look closely", means a call only a person can make. Renames, snapshots, lockfiles, and other mechanical files come last. Every changed file is on the tour. Comments already resolved on the host are left out of the tour and out of the prompt. The diff the inbox already loaded is that pull request only, so a stacked pull request is covered for that layer only.

One guide per pull request head, stored on this machine under a local key. It is not a GitHub object.

The writer is the same text harness that already writes commit text. It runs only when the person clicks Write guide or Rewrite guide, and only with the diff and the unresolved comments already loaded. There is no new GitHub request.

A stop jumps to that file in the existing unified diff.

When the head changes, the stored guide is out of date until someone asks to rewrite it. The old stops are not shown as the current tour. The screen says "This guide is out of date".

A write is kept only if it still matches the head it was based on, and only if no newer write landed while it was running. A late result is dropped. A timeout, a missing harness, or a reply that is not a guide is a failed write. The previous guide, if any, stays. The screen says so in one sentence and does not treat the failure as an empty guide.

## Out of scope

Saved review threads, viewed marks, stack merge, stack rebase, any forge that is not GitHub, and the split diff toggle (WP-116).

## Setting

Review guide. Off by default.

## Labels

Guide. Write guide. Rewrite guide. This guide is out of date. Look closely.
