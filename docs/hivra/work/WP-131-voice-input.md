# WP-131: Desktop voice input into the draft, never auto-send

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none | no |
 This package is Grok OK: no.

## Goal

On the desktop app, the person can dictate into the composer. The text lands in the draft. Nothing is sent until they press send. Phone dictation already exists and is left alone unless a shared model helps both.

## Why

T3 documents voice input in [voice-input.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/voice-input.md): on-device on phones, desktop via an environment. Linux desktop dictation is still an open T3 issue ([#30262](https://github.com/pingdotgg/t3code/issues/30262), 6 +1). Hivra already has phone dictation (`mobile/src/features/sessions/DictationBar.tsx`) and no desktop composer dictation on `origin/main`. Grok OK: no, because this is microphone and audio.

## Read first

- Hivra: `mobile/src/features/sessions/DictationBar.tsx`, composer components, tauri permission patterns.
- T3 behaviour (ideas only): [docs/user/voice-input.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/voice-input.md).

## Build

1. A desktop dictation control on the composer. Permission is requested in plain words the first time. Audio is not uploaded to a Hivra server (there isn't one); use the OS transcription API or a local path the person already has. If a cloud speech API would be required, stop and write that in PR.md instead of adding an account. Tests for the draft update with a stubbed recogniser.
2. Never auto-send. A partial transcript is clearly marked until the person stops talking. Browser or desktop spec as applicable; WebKit and Chromium if the control is in the webview.
3. Document macOS, and say plainly what Windows and Linux can do in this slice. If Linux cannot be done honestly in this package, leave a follow-up in PR.md rather than a broken button.

## What this slice does on each platform

- **macOS:** off in this build. The Dictate button and the Dictate row in the plus menu are shown only where the
  desktop recogniser is available, so they are hidden here. The recogniser is not in the main app: the microphone
  usage strings and the audio-input entitlement were removed from the Hub, because a child process of the app would
  inherit a microphone grant the app holds (project actions, git hooks, setup scripts). The planned path is a helper
  bundle inside the app with its own usage strings, entitlement and disclaimed start. That helper is not built yet.
  The composer code (the explain step, the waiting state with Cancel, the draft write that keeps Undo, the partial
  marking and the never-send rule) stays tested with a fake recogniser, ready for the helper.
- **Windows:** no dictation in this slice. The control is hidden, not shown as a broken button.
- **Linux:** no dictation in this slice. The control is hidden. A Linux path is a follow-up (see PR.md).
- **Phone:** unchanged. The phone's own dictation bar is not touched by this slice.

## Done when

- [ ] Desktop dictation writes into the draft and does not send.
- [ ] No audio is sent to a new vendor account without it being written in PR.md and left unimplemented.
- [ ] Phone dictation keeps working.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
