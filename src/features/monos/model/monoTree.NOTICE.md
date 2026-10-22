# monoTree: third-party notice

`monoTree.ts` and `monoTreePrompt.txt` are a port of UniiChat's `Memory.ts` and
`prompt.txt` (https://github.com/VictorTaelin/UniiChat, commit 0500bf6),
Copyright 2026 Higher Order Company, licensed under the Apache License,
Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). You may not use these
files except in compliance with that License. They are distributed on an "AS IS"
BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.

Changes from the original (MonoCode Hub, 2026):
- The agent's name is the Mono's, and the user is Ash.
- A `seat` kind (another Mono's room post) replaces `ai` (imported chats).
- Images, imports, billing, give/take, acts and agents' chats are removed.
- A compactor that throws marks its node failed until the next message.
- Streams are read whole at load instead of through index files.
- Files go through a `TreeDisk` (node:fs in tests, the app's commands in the hub).
- ES2020 stand-ins for `toWellFormed`, `findLastIndex` and `Buffer`.

Unchanged: the sizes, the tree, the view, the save step (the compaction task,
the ruler, the "Too long" retry, the shortest line kept, the cut), the logs and
their record shapes. `monoTree.parity.test.ts` checks the port against a trace
recorded from the original.
