// C6: the Pages calendar block, drawn by react-day-picker (gpbl/react-day-picker, MIT) with none of its own CSS: every
// part is styled with the hub's theme tokens, so a scheme or theme restyles it like the rest of the app. Read-only:
// no navigation, no selection. Marked days carry their note as a tooltip and in the line under the month.
import { DayPicker, type DayProps } from "react-day-picker";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 2026" as the first of that month; undefined for anything else. */
export function monthOf(label: string): Date | undefined {
  const m = label.trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
  const index = m ? MONTHS.indexOf(m[1]) : -1;
  return m && index >= 0 ? new Date(Number(m[2]), index, 1) : undefined;
}

export function CalendarBlock({ month, marked }: { month: Date; marked: readonly { day: number; text: string }[] }) {
  const note = (date: Date) => (date.getMonth() === month.getMonth() ? marked.find((m) => m.day === date.getDate())?.text : undefined);
  return (
    <DayPicker
      month={month}
      weekStartsOn={1}
      hideNavigation
      disableNavigation
      showOutsideDays={false}
      modifiers={{ marked: marked.map((m) => new Date(month.getFullYear(), month.getMonth(), m.day)) }}
      components={{
        Day: ({ day, modifiers: _modifiers, ...cell }: DayProps) => <td {...cell} title={note(day.date)} />,
      }}
      classNames={{
        root: "w-full",
        months: "w-full",
        month: "w-full",
        month_caption: "hidden",
        caption_label: "hidden",
        nav: "hidden",
        month_grid: "w-full border-separate border-spacing-1 text-center text-[11px]",
        weekdays: "",
        weekday: "pb-1 font-normal text-content/60",
        week: "",
        day: "h-6 rounded-md p-0 text-content/75",
        outside: "invisible",
        today: "font-semibold text-content",
      }}
      modifiersClassNames={{ marked: "bg-theme-accent/20 text-content ring-1 ring-inset ring-theme-accent/40" }}
      formatters={{ formatWeekdayName: (d) => "SMTWTFS"[d.getDay()] }}
      data-block-calendar
    />
  );
}
