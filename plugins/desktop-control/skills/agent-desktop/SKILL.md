---
name: agent-desktop
description: Use Hivra's desktop gate to see and operate desktop apps through the accessibility tree. Off until the person turns the plugin on. A new app asks for consent. Headless unless the person allows visible control.
---

<!--
Vendored from skills/agent-desktop/SKILL.md at agent-desktop 1.2.0.
License: Apache-2.0
The upstream files do not carry a separate copyright line (Apache-2.0).
Changed by adding Hivra's gate, consent and visible-control rules. The observe, act and verify loop is kept.
-->

# agent-desktop

The app starts the desktop server. Use that server's desktop tool. Do not start a program yourself, and do not pass a path, a pin, or a registry. The desktop program is the pinned agent-desktop 1.2.0.

## How to call it

The tool takes the project folder, the app name, the command, and that command's arguments.

- `project` is a full path to the project folder.
- `app` is an app this project allows.
- `command` and `args` are one agent-desktop command. Do not add a path or a pin. Do not pass `--headed` unless the person has allowed visible control for this project. Never add `--headed` to get past a headless failure.

```
snapshot --skeleton --app "Notes" -i --compact
```

## When it refuses

The gate prints one JSON envelope. Branch on `error.code` and `error.disposition`. Do not log secrets, the binary path, or what was on screen.

- `retry: unsafe` is final for that call. Ask the person. Do not work around it, do not call the binary, and do not switch to headed.
- `DESKTOP_CONTROL_OFF`: the plugin is off. The person turns it on. An allow list does not override that.
- `CONSENT_REQUIRED`: this app has not been allowed in this project. Ask the person. Don't try another app or another path.
- `REFUSED_APP`: the person said no. Don't ask again and don't try another way.
- `VISIBLE_NOT_ALLOWED`: drop the idea of `--headed`. Stay headless.
- `retry: safe` (`CONSENT_BUSY`, `CONSENT_UNREADABLE`, `BINARY_MISSING`, `PROJECT_NOT_READY`) means nothing was done. Try the same call again once the file, folder or program is there. A missing binary is the pinned agent-desktop 1.2.0, not a consent question. `BINARY_UNTRUSTED` means the program did not match the pin. That is final. Do not point the gate at another file.

## The loop

agent-desktop reads and operates desktop apps through the OS accessibility tree. Every command prints one JSON envelope (`ok`, `data` or `error`). It is a tool, not an agent: the observe, act and verify loop runs in you.

Use `find` when you know the role or exact name. Otherwise map the app first and drill into one region.

```
snapshot --skeleton --app "Notes" -i --compact   # shallow map, children_count on cut branches
snapshot --root @s8f3k2p9:e3 -i --compact        # drill into one region
click @s8f3k2p9:e12                              # act on a qualified ref
snapshot --root @s8f3k2p9:e3 -i --compact        # verify: re-read the same region
```

Those four lines are arguments the desktop tool forwards for the app you named. `click`, `type`, `get` and `is` take a ref from a snapshot of that same app, and they have no `--app`. `launch` and `close-app` take the app name as their argument, and it has to be the app you named. `clipboard-get` and `session` are refused.

- A small app needs no skeleton. Take a full `snapshot -i`.
- `-i` keeps interactive nodes only, so a row's static-text label is dropped. To tell which row a repeated button belongs to, drill that row's container with `--root` and leave out `-i`. On Windows and Linux that reads the row but does not make its button actionable: a button repeated in other rows is a twin in the window and its ref is refused (see Refs).
- A `--root` drill adds its refs to the same snapshot id. Refs outside the drilled subtree, and the drilled root itself, stay valid; refs that were already inside it are replaced, so an old ref there returns `STALE_REF`.
- Never skeleton a surface (`--surface menu`, `sheet`, `alert`). A surface is already focused.
- An action that opens a menu, sheet or alert lists it in `data.surfaces`. Target that overlay next.
- After an async step, use `wait`. A fixed sleep is a race.

## Refs

- Output refs are qualified: `@<snapshot_id>:e<N>`, for example `@s8f3k2p9:e1`. Pass them to later commands as they are. A bare `@eN` is invalid.
- Refs are valid for one snapshot. After any UI change, re-drill the affected region or take a new snapshot.
- Only addressable elements get refs. Static text and inert containers do not. A node is actionable only when its role is interactive or it advertises a primary action. Focus, context-menu and scroll-into-view alone do not count.
- A command re-identifies the element before it acts. On macOS the ref carries the element's own address, so identical twins each keep their ref. On Windows and Linux a ref resolves only when it was the only element in the window its snapshot captured with its role, native id, name and description, counted even below a skeleton or depth cut, and exactly one live element still matches. Identical twins there have no ref path: only headed mouse input can choose one, and only when the person has allowed visible control.
- `STALE_REF`: the element is gone or no longer matches. Take a fresh snapshot and use the new ref.
- `AMBIGUOUS_TARGET`: an identical element appeared, or the ref was not proven unique at capture. Repeating the ref or re-snapshotting identical twins gives the same refusal; act on a control that is unique in the window.
- `SNAPSHOT_NOT_FOUND`: the snapshot id expired. Snapshot again.

## Delivery and retry

Action results carry `data.disposition` and errors carry `error.disposition`, each with `delivery` and `retry`.

- Retry or substitute an action only when `disposition.retry` is `safe`. Only `not_delivered` is safe.
- Any other delivery value means the action may have landed. A repeat can click, type or submit twice, and `toggle` can undo itself.
- On a result that is not safe, read the live state and decide from that.
- Branch on `error.code` and `error.disposition`. Message text can change.
- The gate's own refusals are `not_delivered`. Unsafe ones are final. Safe ones were not delivered, so the same call can be tried again.

## Headless and headed

Ref actions are headless by default. They use semantic accessibility calls and do not take focus or move the cursor. If no semantic path exists, the action fails closed. `--headed` is forwarded only when this project's visible control is allowed. Never switch to headed mode to recover from a headless failure.

`press` and `screenshot` are visible control even without `--headed`. They need that project's visible flag, and `--app` of an app this project already allowed. `screenshot --screen` is refused. A `--surface` that is not part of that app, including `dock`, is refused. `click`, `type`, `get` and `is` need a ref from a snapshot of the allowed app. `launch` and `close-app` take that app's name. `clipboard-get`, `session`, `batch`, `status`, `list-windows` and `list-displays` are refused. Mouse commands and `drag` are refused too: they cannot be kept on one app.

On Windows, headless `type` has no insert path; `set-value` is the headless way to set text.

Password and other secure fields are redacted. You cannot read a password back. Do not try.

## First run

Every call names the app. There is no command that runs with no app.

1. Ask for the app. The gate records the ask and does not start the program.
2. After the person allows it, `snapshot` reads that app.
3. This skill does not repeat flag lists. A flag the gate does not know is refused.
