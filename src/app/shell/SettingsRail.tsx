import { useState } from "react";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Bot,
  Inbox,
  FolderTree,
  Globe,
  Keyboard,
  MessageSquare,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Zap,
  Chatting,
  Code,
  Lock,
  type IconComponent, Undo2, DashboardSquare, CloudUpload, CheckCheck, Folder, Clock, ChartBreakoutSquare, Book, FileScript } from "../../shared/ui/icons";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import {
  settingsSectionsByGroup,
  type SettingsSectionId,
} from "../../features/settings/model/settings";

const SECTION_ICONS: Record<SettingsSectionId, IconComponent> = {
  general: SlidersHorizontal,
  connections: Terminal,
  appearance: Palette,
  keybindings: Keyboard,
  chat: MessageSquare,
  providers: Bot,
  mcp: Globe,
  skills: Sparkles,
  plugins: Code,
  crew: Bot, // WP-13
  monos: Bot,
  inbox: Inbox,
  worktrees: FolderTree,
  archive: Archive,
  trash: Trash2,
  changes: Undo2,
  decisions: CheckCheck,
  activity: Clock, // WP-78
  "work-log": FileScript, // WP-157
  usage: ChartBreakoutSquare, // WP-108
  connected: Globe, // WP-79
  dashboards: DashboardSquare,
  portable: CloudUpload,
  // WP-75: checked backups.
  backups: Folder,
  history: Clock, // WP-50
  memory: Book, // WP-51
  connectors: Zap,
  teams: Chatting,
  // WP-92: the key vault.
  secrets: Lock,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

/** Body of the project rail while settings are open. */
export function SettingsNav({ section, onSelect, onClose }: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const groups = settingsSectionsByGroup();
  // A folded group (Advanced) opens when asked, and by itself when the section on screen is one of its own.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const holds = (group: (typeof groups)[number]) => group.sections.some((item) => item.id === section);

  return (
    <>
      <div
        ref={lockOverscroll}
        aria-label="Settings"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-none px-2 py-3"
      >
        {groups.map((group) => {
          const open = !group.folded || unfolded.has(group.id) || holds(group);
          return (
            <div key={group.id} className="flex flex-col gap-px" data-settings-group={group.id}>
              {group.folded ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setUnfolded((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  className="flex items-center gap-1 rounded-md px-2 pb-1 text-left text-xs font-semibold text-content/35 hover:text-content/70"
                >
                  <span className="min-w-0 flex-1">{group.label}</span>
                  <ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} strokeWidth={2} />
                </button>
              ) : (
                <div className="px-2 pb-1 text-xs font-semibold text-content/35">{group.label}</div>
              )}
              {open
                ? group.sections.map((item) => (
                    <NavRow
                      key={item.id}
                      label={item.label}
                      icon={SECTION_ICONS[item.id]}
                      active={item.id === section}
                      onClick={() => onSelect(item.id)}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-col gap-px p-2">
        <NavRow label="Back" icon={ArrowLeft} onClick={onClose} />
      </div>
    </>
  );
}

function NavRow({
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: IconComponent;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
        active
          ? "bg-selection text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
        {label}
      </span>
    </button>
  );
}
