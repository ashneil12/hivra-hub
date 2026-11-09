# WP-128: Schedule a prompt to run once at a chosen time

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | none | yes |


## Goal

The person can schedule one prompt, on one chat or a new chat in a project, to run once at a chosen local date and time. Recurring automations that already exist stay as they are. If the scheduled run cannot fire while the desktop is closed, the confirm dialog says so (a background host is WP-133, not this package).

## Why

Scheduled prompts had 68 upvotes in the 6 Nov T3 survey. T3 shipped recurring schedules in V2 and one-time schedules in [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7). Hivra's automations only run while the desktop is open (`PLAN.md` Aether item 4). One-time is the slice people asked for first.

## Read first

- Hivra: automations feature, any existing schedule store, `PLAN.md` notes on automations requiring the desktop.
- T3 behaviour (ideas only): [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7) 'One-time schedules'.

## Build

1. A one-time schedule model: project or chat, prompt text, local timestamp, status (scheduled, fired, missed, cancelled). Survives restart while the app is running. Tests for persist, fire, cancel, and a missed slot (app was closed at the time): status becomes missed, and the person is told on next launch.
2. UI to create, list, cancel. Confirm copy must say if a closed app will miss the run. Browser spec.
3. Do not install a LaunchAgent, systemd unit, or background service in this package.

## Done when

- [ ] A one-time schedule fires at the time while the app is open, and is marked missed if the app was closed.
- [ ] The confirm dialog is honest about a closed app.
- [ ] No login item or service was installed.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
