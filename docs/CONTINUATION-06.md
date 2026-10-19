# Continuation 06: MonoCode improvements

This batch follows Ash's 16 October request to fix the reported issues directly and use a separate copy for testing. The public name remains MonoCode for now. Internal service names and storage identifiers are retained for compatibility.

## Changes

- Group conversations call the same Mono session engine as direct messages. The selected Mono keeps its model, tools, history and identity. Real errors are shown; the production path cannot generate the old canned replies. Only the example preview can simulate replies.
- Groups, explicit membership and conversations persist and are included in setup export/restore. Imported nested messages are validated. Pending replies become visibly interrupted on restart. Retry is tied to its originating conversation and user message.
- The Mono list collapses, scrolls within a bounded height and filters by explicit project assignment. Today and the Add a Mono picker retain the complete roster. Moving between projects does not duplicate or delete a Mono. Deleted Leads are not automatically recreated. Own names are the default; existing explicit role-name preferences are retained.
- Custom models can define supported reasoning effort levels, including on an existing model. The picker exposes only those levels, and the route forwards the selected level as `reasoning_effort`. Existing models retain provider defaults. No effort capabilities are inferred from a provider name. The nonfunctional OAuth choice is removed from the custom API model form; native agent subscription authentication remains separate.
- Context is visible in the main and floating Mono composers. A missing reading/window is shown explicitly rather than disappearing; the tooltip identifies it as the last provider report. A new helper test exercises live changes to the context passed from SessionPane. This does not prove the reported frozen live session is repaired.
- Pages can build through the chosen seated Mono and validate its real JSON before previewing. Structured builds get a larger reply allowance than ordinary chat. The old service endpoint and explicit development stub remain available for their existing callers.
- Today has project access and local Pages/Notes/Automations shortcuts. Ask search includes Later and Older and pages a large result set 25 rows at a time. A test covers 65 asks. A project with only Later items remains accessible.
- New Hub installs can complete onboarding. Mono implementation instructions and the repository's working loop distinguish source changes, checks, delivery and verification in the actual app.
- `hub:test-copy:build` creates MonoCode Test with an isolated bundle/data identity. The compiled test feature must match that identity. Model and connector Keychain operations use separate services; the live harness bridge/MCP export are disabled; Claude sessions use a separate config directory with inherited MCP/hooks disabled. It skips the daily app's orphan reaper. This is app-data and harness isolation, not a general OS filesystem/network sandbox. Other installed agent CLIs retain their own provider-specific behaviour. *Retired in Phase 1b (WP1): these compile-time checks became runtime rules for every dev copy (`src-tauri/src/instance.rs`; CLAUDE.md, "Which copy is which").*

## Design brief

Keep the existing dark, quiet interface and meaningful status colour. Today must make projects and common tools reachable, show what changed, and let a large backlog be found without a wall of rows. Use compact project entry cards, progressive disclosure and a collapsible Mono section. Preserve identity and explicit group membership.

References were reviewed from the existing handoff reference pack before these changes: Conductor's compact activity list, Vibe Kanban's project strip and working/detail separation, and Crystal's collapsible project/session tree. Borrow hierarchy and density, not their branding or status colours. The screenshots are in the existing `hub-handoff-2026-10-15/spec-pack/harness-refs/screens` folder.

## Verification boundaries

The web and Rust checks, browser preview, independent code review and isolated bundle build are separate evidence steps. No passing source test proves an authenticated provider or the installed daily app works. The Mac was locked when native UI verification was attempted. Ash OS tools were left alone as requested. Provider limits/credits and the real backlog execution remain operational dependencies; this batch does not claim they are repaired.

The built-in orchestration engine has not been adopted as a replacement. A trial still needs to demonstrate a bounded job, worker result, independent check and visible result. Memory ownership or the underlying registry has not been redesigned.
