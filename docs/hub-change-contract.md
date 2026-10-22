# Level 2 change contract: Change the hub, Edit Today, Connect data

All three flows share one seam: `src/features/hubChange/model/hubChange.ts`. The UI follows the locked Level 2 pattern:
- the limits line;
- "You ask, and one of your seated Monos builds it. Temporary workers can't.";
- **Now** beside **Preview** (the preview build);
- "This is a preview build. Your live hub hasn't changed.";
- **Apply** or **Discard**;
- Undo later in Settings → Changes → Bot changes.

## Calls

All calls go through the hub transport (`hub.rs`), like the other `ash-hub-*` calls.

| Action | Payload | Result |
|---|---|---|
| `ash-hub-change-preview` | `{ flow: "hub" \| "today" \| "connect", projectId, monoId, prompt }` | `ChangePreview` |
| `ash-hub-change-apply` | `{ previewId }` | anything (swap the preview build in) |
| `ash-hub-change-discard` | `{ previewId }` | anything (throw the preview build away) |
| `ash-hub-change-undo` / `-redo` | `{ previewId }` | anything (revert or re-apply; called by Bot changes) |

```ts
type ChangeSide = { image?: string /* data: URL of the preview build's screenshot */; sections: { title: string; rows: string[] }[] };
type ChangePreview = { previewId: string; title: string; by: string /* the Mono's name */; now: ChangeSide; preview: ChangeSide };
```

- **Waiting and history:** previews send `wait: 30` and show "still building" with Try again. Ash OS's history
  (`ash-hub-changes`) is the source for the list under the ask box, the last change on Today and Bot changes;
  Undo / Redo call the studio and re-read `ash-hub-layout` (Today) and `ash-hub-projects` (the strip).
- **Who may ask:** only a seated Mono, meaning one on the Monos roster. The app turns temporary workers away before calling, and the backend must check too.
- **The backend's job:** the Mono asks Claude Code to make the change in a separate preview build. It answers with both sides: an `image` of each, or an outline of `sections`.
- **Errors:** `unreachable`, `timeout`, `unauthorized` or `refused` show **Not connected yet**, with a line saying which flow isn't wired. The flow never pretends.
- **Flows:**
  - `hub`: changes to the hub itself, such as the sidebar or layout. Limits: no keys or Keychain, no account sign-ins, no deleting projects or Monos, no skipping the preview.
  - `today`: changes to the Today board. Same limits and same flow.
  - `connect`: hooks a page or dashboard to Ash's own backend or private data, set up by the Mono with no source download. Passwords and keys go only to the Mac Keychain, through the existing key flow.
- **A change to the app itself** (how a screen looks or works, or anything in its engine: Rust, providers, the chat
  engine): not a change here. The Mono answers `turnDown` with `appCode: true` and Ash OS says "<Mono> says this is a
  change to the app itself: <why>". The app shows **This changes the app itself** with why, and **Send to MonoCode Hub
  lead** (`appChange.ts`): his words go into that Lead's own chat through the composer's send, ending "(sent from Change
  the hub)"; the Lead makes it in a worktree, shows him a dev copy to try, and ships it when he says so. The Change the
  hub and Edit Today screens say so under the limits line.
- **The in-app lane, two parts** (Ash 22 Oct: "it can improve itself n its ui yes but the core code is diff"): inside a
  dev copy the app may change its own look and UI in place (`self_build.rs`, Now | Preview | Apply | Discard | Undo under
  `src/` and `public/`); core code — the engine (`src/integrations/`, `src/platform/`, the chat engine in
  `src/features/sessions/model/`, the hub's own store in `src/features/hub/model/`, the app's own tools in
  `src/features/agent-app/`), Settings, keys, the Monos list, how it starts, or the change flow itself — is refused
  there in plain words and goes the Lead's way, where it is built and checked first. The installed hub refuses every
  in-app change: it would need a rebuild, so it all goes to the Lead.
- **Dev only:** example previews show when `localStorage["monocode:hub-change-dev-stub"] = "1"`. Every made-up row starts with "Example:".

## What the Mono is told

> Ash asked for a change ({flow}) in MonoCode Hub: "{prompt}". Ask Claude Code to build it in a preview build, never the live hub. Don't touch keys, the Keychain, sign-ins, or deleting projects or Monos. Colour is for status only, and use the theme tokens. When the preview build is ready, return a ChangePreview: a short plain title, and Now and Preview as screenshots (or sections of rows). Label made-up data "Example:".
