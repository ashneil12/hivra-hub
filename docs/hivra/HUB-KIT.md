# The hub kit

Every bespoke hub gets the kit: its styles load before the hub's own CSS, and a `kit` global of small builders is
ready before the hub's script runs. Build a hub from these parts instead of drawing rows by hand. The four ready-made
hubs (Agents, Needs you, Being built, Projects) are built from them, so a hub made from the kit looks like the app.
The source is `src/features/pages/model/hubKit.ts`; the ready-made hubs are in `readyPages.ts`.

Rules that come with it (docs/hivra/DESIGN.md section 4): theme tokens only, status colours only for a real state,
small text at 60% or more, 13px body and 12px hints, one primary button per surface, one sentence when a list is empty.

## The page

```html
<div class="k-page">
  <div class="k-head"><div class="k-lede" data-summary>Reading…</div></div>
  <div class="k-stats" data-stats></div>
  <section class="k-section">
    <div class="k-section-head">Working <span class="k-count">2</span><span class="k-spacer"></span><button class="k-btn">Refresh</button></div>
    <div class="k-card" data-list="working"></div>
  </section>
</div>
```

Don't put an `h1` with the hub's name: the app draws the title above the frame. `hidden` always hides a part.

## Parts (CSS classes)

| Part | Classes | Use it for |
| --- | --- | --- |
| Page | `k-page` | The one column every hub sits in (22px between parts). |
| Head | `k-head`, `k-lede` | One line saying what's here, with a quiet button on the right. |
| Numbers | `k-stats` > `k-stat` | Up to four numbers on top. `data-tone="bad"` turns the number red; only for Needs you. |
| Section | `k-section`, `k-section-head`, `k-count`, `k-spacer` | A titled group with its count. |
| Card | `k-card` (`k-pad` for padding) | The surface a list of rows sits on. |
| Row | `k-item` > `k-row`, `k-main`, `k-title`, `k-sub`, `k-text`, `k-aside`, `k-actions` | One thing in a list: picture, name, a line under it, what it's doing, its state, its buttons. Rows in a card get a line between them. |
| Nested rows | `k-nest` | The work under a row (a rail on the left, smaller rows). |
| Tile | `k-grid` > `k-tile` | Small cards side by side, for things that are quiet (idle agents, projects at a glance). |
| Picture | `k-avatar` (`k-sm` small) | Initials or an icon, with a status dot in its corner (`data-tone`). |
| State | `k-pill` (`data-tone`, `data-live` pulses) | The state word: Working, Asking, Done. |
| Dot | `k-dot` | A bare status dot. |
| Tag | `k-tags` > `k-tag` | Small neutral labels (11px). |
| Button | `k-btn`, `k-primary`, `k-quiet`, `k-icon-only` | Text buttons; one `k-primary` per surface. |
| Question | `k-callout`, `k-callout-text`, `k-callout-hint` | What a row asks, with its suggestion, under the row. |
| Field | `k-field` > `k-input` | A box to type an answer, with its Send button. |
| Meter | `k-meter` > `span` | A progress bar (`data-tone` colours it). |
| Empty | `k-empty` | The one sentence when there is nothing, under a quiet picture. |
| Note | `k-note`, `k-problem` | What a tap said; why something couldn't be read. |
| Hidden for the eye | `k-sr` | Text a screen reader keeps but the page doesn't show. |

Tones (`data-tone`): `ok` green (working), `warn` amber (asking, waiting), `bad` the Needs you red (only when the owner
must act), `idle` grey. `kit.tone(state, needsYou)` turns a state word into its tone.

## Builders (`kit.*`)

Each returns a DOM node; text always goes in as text, never as HTML.

| Builder | Makes |
| --- | --- |
| `kit.el(tag, cls, text)` | Any element. |
| `kit.add(parent, kids)` | Appends nodes or strings, skipping empty ones. |
| `kit.icon(name)` | One of the icons below (14px, stroke 1.75). |
| `kit.avatar(name, { tone, icon, small })` | A picture: the name's initials, or an icon. |
| `kit.pill(tone, text, { live })` | A state. |
| `kit.stat({ label, value, tone, onClick })` | A number tile. |
| `kit.button(label, onClick, { primary, quiet, icon, iconOnly, name, hook })` | A button. `name` adds who it is for to its label ("Open EXO lead"); `hook` adds a `data-` attribute. |
| `kit.row({ lead, title, sub, aside, actions, onClick })` | A row. |
| `kit.tile({ lead, title, sub, aside, body, actions, onClick })` | A tile. |
| `kit.section(title, { count, tone, actions, body })` | A section with its head. |
| `kit.callout(text, { hint, tone, body })` | A question under a row. |
| `kit.empty(text, icon)` | The empty sentence. |
| `kit.meter(value, max, tone)` | A progress bar. |
| `kit.tag(text)` | A tag. |
| `kit.ago(ms)` | "now", "5m", "3h", "2d". |
| `kit.tone(state, needsYou)` | The tone for a state word. |
| `kit.initials(name)` | "Chief of Staff" gives "CS". |

## Icons

`kit.ICONS` lists them: open, stop, message, reply, check, alert, clock, chevron, down, folder, users, bot, spark,
build, inbox, refresh, plus, search, calendar, chart, doc, link, play, pause, hand, moon.

## A small hub from the kit

```js
const list = document.querySelector('[data-list="working"]');
hub.watch("agents.read", (d) => {
  list.textContent = "";
  const busy = d.agents.filter((a) => a.state === "working");
  for (const a of busy) {
    const item = kit.el("div", "k-item");
    item.appendChild(kit.row({
      lead: kit.avatar(a.name, { tone: kit.tone(a.state) }),
      title: a.name, sub: a.doing,
      aside: kit.pill("ok", "Working · " + kit.ago(a.since), { live: true }),
      actions: [kit.button("Open", () => hub.call("chats.open", { agentId: a.id }), { icon: "open", name: a.name })],
    }));
    list.appendChild(item);
  }
  if (!busy.length) list.appendChild(kit.empty("Nobody working right now.", "moon"));
});
```
