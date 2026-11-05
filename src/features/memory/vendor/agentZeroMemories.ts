// Copyright (c) 2025 Agent Zero, s.r.o.
// SPDX-License-Identifier: MIT
// Source: https://github.com/agent0ai/agent-zero plugins/_memory/prompts/agent.system.memories.md
// The licence text is LICENSE.agent-zero beside this file.
//
// The memories prompt, copied. {{memories}} is filled when a turn is built.
// Rewrite reason: the original is a system-prompt template; Hivra places the
// same words inside the turn, fenced as untrusted.

/** Agent Zero's memories prompt, word for word. */
export const AGENT_ZERO_MEMORIES = `# Memories on the topic
- following are memories about current topic
- do not overly rely on them they might not be relevant
- when timestamps are present, use them as a soft staleness signal: newer/current memories usually win for mutable facts
- old memories can still be valid durable preferences or project facts; do not ignore or forget them only because they are old
- if memories conflict, prefer the newest/current fact and ignore superseded older fragments

{{memories}}
`;
