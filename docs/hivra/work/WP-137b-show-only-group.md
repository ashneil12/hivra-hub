# WP-137b: Show only this group

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | WP-137 design | yes |

The first slice of WP-137. That note names no recommended first slice. This is the smallest piece it lists first: a per-window filter on a project group that already exists.

## Slice

A setting, off by default. With it off, the project rail is today's rail. The same projects show, in the same order, with the same pins.

With the setting on, each project group offers "Show only this group". That is a second action. Selecting a group, or expanding it, does not turn the filter on. The choice belongs to this window. It is not a field on the group, and it is not written into the saved rail order. Closing the window drops it and writes nothing. A restart shows the full rail.

While the filter is on, the rail shows that group's projects and no others. A pinned project that is in the group stays in Pinned, in the same pin order. Other projects are not archived, deleted, or moved. "Show every project" brings them back in the same places.

An empty group shows an empty section. It does not pull in other projects. A requested group id that is not in the list is ignored: the full rail stays in its saved order, and the rail says "That group is no longer there." That is not a successful filter.

The chat list, chat folders, Being built, the split tree, and extra windows are not touched. This slice does not call `summaryFromSession`.

## Out of scope

- A space object, a space table, or the word space on screen.
- A project in more than one group.
- Split view. That is already the workspace pane tree.
- Extra windows. New Window already exists.
- A macOS tray.
- Re-sorting the chat list, the project rail, or Being built.
- Moving a chat into a folder, or filing a new chat into the open group.
- Saving the filter across a restart.

## Fail closed

- The setting is missing, unreadable, or any value other than the saved on values: off. The rail is unchanged.
- The filter names a group that is not in the list: the full rail, a plain sentence, and not an empty rail treated as success.
- A drag while some projects are hidden does not save a new order, so a hidden project cannot be dropped.
- Storage failing to save the setting: the switch can still flip for this window. A failed read stays off.

## Done when

- [ ] The setting is off by default, and a bad stored value stays off.
- [ ] With the setting off, the rail projects and their order match the unfiltered rail.
- [ ] With the setting on, "Show only this group" hides other projects and "Show every project" restores the same order.
- [ ] A missing group shows the plain sentence and the full rail. An empty group stays empty.
- [ ] Two windows can filter different groups, and neither writes the rail order.
- [ ] A browser spec covers the above on Chromium and WebKit.
- [ ] No em dashes or en dashes in text a person sees.
