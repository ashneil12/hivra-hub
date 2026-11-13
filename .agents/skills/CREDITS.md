# Design skills borrowed from other people

Copied whole, with their licence beside them, on 12 Nov 2026 (Ash: "there are so many design repos ... look them up
and use them"). They are for agents working in this repo; `hub-taste` says which one to read when.

| Skill folders | From | Licence |
| --- | --- | --- |
| `better-ui`, `better-layout`, `better-colors`, `better-typography`, `better-interface`, `better-accessibility`, `better-writing`, `interface-review` | [jakubkrehel/skills](https://github.com/jakubkrehel/skills) (Jakub Krehel) | MIT |
| `emil-design-eng` | [emilkowalski/skills](https://github.com/emilkowalski/skills) (Emil Kowalski) | MIT |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 (its `LICENSE.txt`) |
| `ui-sdk` | [vercel-labs/ui](https://github.com/vercel-labs/ui) `packages/core/skills/ui-sdk` at 8ff6bcf7 (Vercel), added 13 Nov 2026 | Apache-2.0 (its `LICENSE`) |

`hub-taste` is ours. It also draws on [pbakaus/impeccable](https://github.com/pbakaus/impeccable)'s Operate mode and
craft floor (Apache-2.0) and [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT), rewritten for
hubs rather than copied.

`ui-sdk` goes with the `@ui-sdk/react` and `@ui-sdk/core` packages in `package.json` (pinned to one exact beta
version; the skill is that version's own copy, so move both together). It is behaviour, not looks: keyboard, focus,
popups, selection and the ARIA they need, plus a way for an agent to read and press a screen's controls by name. Use
it for a control the app does not have yet. Never swap a component that already works for one of its: `dropwave-ui`
section 2 says why.
