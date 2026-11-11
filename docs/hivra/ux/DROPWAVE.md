# Dropwave preview

A clickable preview of the captain-first Dropwave screens, built as real React in `src/features/dropwave/` on example
data. It is not wired to anything: no CLI, folder, key or network call. It is separate from the app build
(`vite.dropwave.config.ts`), so it never changes what ships.

```bash
npm run dropwave:build   # -> target/dropwave/dropwave.html + assets/, and page.html (one inlined page for an Artifact)
```

What it shows:
- Home is one of the projects in the rail. Every project opens on its Chief of Staff chat, with cards underneath:
  Needs you, Being built, Decided for you (with Undo), Pinned pages, Automations, Done today.
- First mates each have their own chat (with their crew and their decisions), switched from the sidebar.
- Teams are optional group chats (`+ New team`, `@` a member).
- Questions arrive in batches; answer by tapping, or type `1a 2b` and send.
- The Agents board shows who is doing what, with filters.
- Autopilot is a per-project mode. Git, worktrees and diffs sit under Settings > Advanced.
- The first open asks how hands-on you want to be.

The journey behind it: the "Dropwave user journey" doc. The static boards: the "Dropwave screens" canvas.
