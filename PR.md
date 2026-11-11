# WP-212 Home with the Chief of Staff

## What changed

Home's box sends Ash's words as one turn to the Chief of Staff Mono's own chat, the same session the sidebar opens. The reply streams back into the box, with "Open full chat". If that Mono is missing, Home offers "Add the Chief of Staff" and files nothing.

Under the chat there are three sections, and each one hides when it is empty: Needs you (five rows, oldest first), Working now, and Done today. The header is "Home", today's date, and one Customize button. With nothing to show, the line is "Nothing needs you."

The project list, the usage line, the morning summary, and the old filing path are gone from Home. `src/features/home/model/ask.ts` is deleted. The chief's own `answer.ts` stays, because the summary still reads it.

The WP-210 stub is `src/features/needs/model/needsYou.ts`. It exports `needsYou`, `useNeedsYou`, `needsCount` and `workingCount`. The list starts empty.

Round 2 added the before and after shots, and two checks in `tests/browser/wp212-home.spec.ts`: the entrance fade has finished before the home shot, and the pinned panel stays inside the 1440x900 screen. No screen code changed in this round. The after shots read as one chat with the Chief of Staff, then Needs you, Working now and Done today. Nothing was clipped, overlapping or empty.

## Commands

- `npx tsc --noEmit`: no errors.
- `npx vitest run src/features/home src/features/needs`: 79 passed, 0 failed.
- `npx playwright test tests/browser/wp212-before.spec.ts`: 4 passed, 0 failed (chromium and webkit). The spec and its fixture were deleted after the shots and are not in the commit.
- `npx playwright test tests/browser/wp212-home.spec.ts`: 4 passed, 0 failed.
- `npx playwright test tests/browser/wp73-home.spec.ts`: 6 passed, 0 failed.
- `npx playwright test tests/browser/wp88-home.spec.ts`: 2 passed, 0 failed.
- `npx playwright test tests/browser/wp161-builder-hold.spec.ts`: 4 passed, 0 failed.

## Couldn't check

- `git switch --detach c7e9e737d` was not approved, so the before shots were not taken from a detached checkout. They were taken with that commit's `HomeScreen.tsx` in place (byte for byte the same file; the branch diff does not touch the modules it imports), then the branch file was restored.
- Seeded dev-copy shots were not taken. `hub:dev` was not started.
- `npm run check` was not run.
- No Rust in this change, so cargo was not run. About 85 GB was free on the home volume.

## Screenshot pairs

Same names under `docs/hivra/work/shots/wp-212/before/` and `docs/hivra/work/shots/wp-212/after/`, example data, 1440x900:

- `home.png`
- `customize.png`
- `turn.png`
- `empty.png`

Head: fae8129cf. Not pushed.

## Round 3

The turn under the box now says who said what. Ash's line is labelled "You" and uses the full chat's bubble, right aligned. The reply is labelled with the Chief of Staff Mono's own name ("Coordinator" in the example), never a raw id. A suggested reply is the chat's option chip: a button under the reply, with the label as its accessible name, and it stays in the tab order. While a reply is still arriving, the words that have arrived show in the chat's own reply renderer. Before the first word, the line is "Thinking", not an empty box and not "Replying".

The new checks were written first and failed (11 passed, 4 failed in `src/features/home/ui/homeScreen.test.ts`). They pass with the fix. `tests/browser/wp88-home.spec.ts` looked for both lines inside one box, so it now reads Ash's line and the reply separately.

`turn.png` was read after the spec rewrote it. "You" sits on the right hand bubble, "Coordinator" sits on "EXO is fine.", and "Sounds good" is a chip under that reply. `customize.png` was rewritten by the same spec because the turn is in that shot. `home.png` and `empty.png` did not change.

## Commands

- `npx tsc --noEmit`: no errors.
- `npx vitest run src/features/home/ui/homeScreen.test.ts` before the fix: 11 passed, 4 failed.
- `npx vitest run src/features/home src/features/needs`: 83 passed, 0 failed.
- `npx playwright test tests/browser/wp212-home.spec.ts`: 4 passed, 0 failed.
- `npx playwright test tests/browser/wp73-home.spec.ts`: 6 passed, 0 failed.
- `npx playwright test tests/browser/wp88-home.spec.ts`: 2 passed, 0 failed.

## Couldn't check

- `npm run check` was not run.
- No Rust in this change, so cargo was not run.
- Free disk space was not read. The disk command was not approved.
- A mid-stream frame was not screenshotted. The streaming checks are the unit tests. The turn shot is the finished reply.
- Seeded dev-copy shots were not taken. `hub:dev` was not started.

Head: 429058f57. Not pushed.

## Round 4

Home now matches the main mockup's pane. One card holds the exchange and the composer. Needs rows show their own buttons. A stopped row says Stopped. Section headers carry a mark and a count. Customize is a small panel.

| Item | Commit | Test |
| --- | --- | --- |
| 1. One chat card, composer at the bottom, send turns blue with text | cae5f52fb | `src/features/home/ui/homeScreen.test.ts` ("names the chief", "with no exchange", "the send arrow turns blue") |
| 2. Needs actions, at most three, first one blue, wired to the item's run | 1e07ef00c and cae5f52fb | `src/features/home/model/needActions.test.ts`, `src/features/needs/model/needsYou.test.ts`, home screen "a question row shows its own actions" |
| 3. Stopped. in red, then the reason, then Open chat | cae5f52fb | home screen "a stopped row says Stopped" |
| 4. Boxed project chip. Examples use Hivra and EXO, and seeded rows start with Example: | cae5f52fb | home screen "shows at most the rows", `tests/browser/wp212-home.spec.ts` |
| 5. Count beside the title, red dot, blue dot, check, See all in blue | cae5f52fb | home screen "hides an empty section" and "shows working and done" |
| 6. The card says Chief of Staff. Add the Chief of Staff stores that name. pickChief still matches Coordinator | 5717b6ea6 | `src/features/home/model/chief.test.ts` ("adds the starter chief") |
| 7. Customize panel: move buttons, a Show switch, Unpin, Done, click outside | cae5f52fb | home screen "keeps customize on one button", `tests/browser/wp73-home.spec.ts` |
| 8. The chief host effect depends on homeDir | 42018d46f | `src/features/home/model/homeChiefHost.test.ts` |

Shots: 09fe6bf17.

### Against Main.png

The shots are the home pane only. The rail, the sidebar and the usage line are not this package.

- `home.png`. Same card: you on the right, CS avatar, Chief of Staff in bold, "read all 7 projects" in grey beside the name, the reply, a blue first reply and a bordered second one, Open full chat on that row, the composer under them. Needs you has a red dot, the count beside the title, and See all in blue. Yes is blue, Not yet has a border. Stopped. is red, then the reason, then a bordered Open chat. Working now has a blue dot and the worker count. Done today has a check and a count, and no See all. Project names sit in small boxes.
- `turn.png`. Same pane after a send. The you bubble is "how is EXO going?", the reply is "EXO is fine.", and Sounds good is the blue chip beside Open full chat.
- `customize.png`. Main.png does not open this panel. The panel has one row per section, with up and down buttons and a Show switch, plus Unpin on the pinned page, and Done. It sits over the card. Done today is switched off, so that section is hidden, and Working now is above Needs you.
- `empty.png`. Main.png has no empty state. The card is the name line and the composer, then "Nothing needs you."

Left on purpose:

- Seeded rows start with "Example:" (UX rule 5). The mockup does not.
- The send control stays grey until the field has text. The brief asks for that. Main.png shows it blue while the field is empty.
- The first action on a needs row is blue. Main.png draws Yes and Not yet both grey. The brief asks for the primary action in blue.
- Two needs rows, one working row and one done row, so the pinned page still fits in the 900px shot. The header example in the brief is "Needs you 2".

## Commands

- `npx tsc --noEmit`: no errors.
- `npx vitest run src/features/home src/features/needs src/features/monos`: 1047 passed, 0 failed.
- `npx playwright test tests/browser/wp212-home.spec.ts`: 4 passed, 0 failed (chromium and webkit).
- `npx playwright test tests/browser/wp73-home.spec.ts`: 6 passed, 0 failed.
- `npx playwright test tests/browser/wp88-home.spec.ts`: 2 passed, 0 failed.

## Couldn't check

- `npm run check` was not run.
- No Rust in this change, so cargo was not run.
- Free disk space was not read. The disk command was not approved.
- Seeded dev-copy shots were not taken. `hub:dev` was not started.
- The send control was not shot while the field still has text. The unit test and the browser spec check that it turns blue. The shots are taken after send, so the field is empty again.

Shots: 09fe6bf17. Not pushed.
