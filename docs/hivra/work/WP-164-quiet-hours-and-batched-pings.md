# WP-164: Quiet hours and batched notable-event pings

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| First Mate smoothness (Ash 10 Nov 00:14 UK) | S | WP-88 morning habit (on main), notification preferences (on main), WP-157 helpful | yes |

## Goal

The person can set **quiet hours** (for example overnight) when the programme lead and First Mate do not send routine notifications. Notable events (security-park need, real CI red, decision waiting) are **batched** into at most a few timed pings, and the existing Chief of Staff morning habit becomes the morning rundown that names what the programme did.

## Why

Ash: overnight hunting stays quiet; tell him in the morning. Tonight's CoS followed that. Hivra already has mute windows on project notifications and a morning habit (WP-88), but no programme quiet-hours policy and no batching of notable programme events into timed digests.

## Read first

- `src/features/notifications/model/notificationPreferences.ts` (`mutedUntil`, categories).
- `src/features/chief/model/habit.ts` morning habit.
- WP-157 work log (queued): rundown should prefer outcome lines when present.

## Build

1. Docs to `docs/hivra/work/WP-164-quiet-hours-and-batched-pings.md`.
2. Project (or app) setting: quiet hours start/end local time; during quiet hours, suppress `agentFinished` and similar routine categories for programme ticks; never suppress `agentInput` (approvals / decisions) unless the person also muted that category. Tests.
3. Notable-event buffer: park-needed, real CI red, tick failed. Flush at most every N minutes (default 30) as one notification with a short list, and always include leftovers in the morning habit context. Tests for batching and flush.
4. Extend morning habit instructions (only if still the stock text; do not overwrite a person-edited habit) to read programme queue + work log summary. Tests for `withMorningHabit` leave-edited-alone.
5. Out of scope: SMS, email send, phone push (mobile wave), installing LaunchAgents.

## Done when

- [ ] Quiet hours suppress routine programme noise and still surface decisions unless muted.
- [ ] Notable events batch; morning habit can name programme outcomes.
- [ ] Person-edited morning habit text is never overwritten.

## Licence

Product behaviour. Builds on existing notification mute and WP-88.
