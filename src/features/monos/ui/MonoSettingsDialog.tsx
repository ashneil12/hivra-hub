import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { isImeComposition } from "../../../shared/lib/keyboard";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { Modal } from "../../../shared/ui/Modal";
import { Popover } from "../../../shared/ui/Popover";
import { Settings, Sparkles, StickyNote } from "../../../shared/ui/icons";
import type { HarnessId, RuntimeMode } from "../../sessions/model/session";
import { AccessPicker } from "../../sessions/ui/AccessPicker";
import { PixelMascot } from "../../projects/ui/PixelMascot";
import {
  defaultMonoName,
  findMono,
  LETTER_AVATAR,
  monoTileLetters,
  saveMonoMascot,
  saveMonoName,
  saveMonoTileLetters,
  subscribeMonos,
  updateMono,
  type MonoLook,
  type MonoState,
} from "../model/mono";
import { closeTree, openTree } from "../model/monoTreeStore";
import { CaptainPersonality } from "../../chief/ui/CaptainPersonality";
import { hasCaptainCharter } from "../../chief/model/charter";
import { ensureMorningHabit } from "../../chief/model/habit";
import { soulAsks } from "../../chief/model/scope";
import { loadHabits, updateHabits } from "../model/monoHabits";
import { ConfirmReset } from "./ConfirmReset";
import { LongChatView } from "./LongChatView";
import { MemoryPage, SoulPage, useMonoFiles } from "./MonoFilePages";
import { MonoProjects } from "./MonoProjects";
import { ColorPicker, MascotPicker, SwitchRow } from "./monoPanelParts";
import { MonoCard } from "./MonoCard";

export type MonoSettingsSection = "general" | "soul" | "memory";

const SECTIONS: {
  id: MonoSettingsSection;
  label: string;
  icon: typeof Settings;
}[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "soul", label: "Soul", icon: Sparkles },
  { id: "memory", label: "Memory", icon: StickyNote },
];

type Props = {
  monoId: string;
  agent: MonoLook;
  /** Its soul and memory reload when a turn ends. */
  status: MonoState["status"];
  /** Its conversation's folder, which the model picker reads settings from. */
  cwd: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  busy?: boolean;
  initialSection?: MonoSettingsSection;
  onModelChange: (harness: HarnessId, model: string) => void | boolean;
  onModelSettingsChange: (settings: Record<string, string>) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onReset?: () => Promise<void>;
  onClose: () => void;
};

/**
 * Who the Mono is and how it works, in a dialog of its own: its name, face,
 * model and projects under General, then its soul and memory.
 */
export function MonoSettingsDialog({
  monoId,
  agent,
  status,
  initialSection = "general",
  onClose,
  ...general
}: Props) {
  const [section, setSection] = useState(initialSection);
  const files = useMonoFiles(monoId, status);
  return (
    <Modal
      title={`${agent.name} settings`}
      size="lg"
      minimalHeader
      fitViewport
      onClose={onClose}
      // Centre the close button in the section header's 40px row.
      className="h-[min(680px,calc(100dvh-32px))] [&>.modal-panel>header]:top-1.5"
    >
      <div
        className="flex h-full min-h-0 font-sans"
        // Section headers leave room for the dialog's close button.
        style={{ "--mono-window-controls-width": "2rem" } as CSSProperties}
        data-mono-settings
      >
        <nav
          aria-label="Settings sections"
          className="flex w-48 shrink-0 flex-col gap-px border-r border-stroke p-2"
        >
          <p className="px-2.5 pb-2 pt-1.5 text-[11px] text-content/45">
            Settings
          </p>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${
                section === id
                  ? "bg-content/8 text-content"
                  : "text-content/65 hover:bg-content/5 hover:text-content"
              }`}
            >
              <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {section === "general" ? (
            <GeneralSection monoId={monoId} agent={agent} soul={files?.soul} {...general} />
          ) : section === "soul" ? (
            <SoulPage monoId={monoId} agent={agent} files={files} />
          ) : (
            <MemoryPage monoId={monoId} files={files} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function GeneralSection({
  monoId,
  agent,
  soul,
  cwd,
  harness,
  model,
  modelSettings,
  runtimeMode,
  busy = false,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
  onReset,
}: Omit<Props, "status" | "initialSection" | "onClose"> & { soul?: string | null }) {
  const lock = useLockOverscroll<HTMLDivElement>();
  const shown = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.showStartedSessionsInSidebar === true,
  );
  const folders = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.useSidebarFolders === true,
  );
  const longChat = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.longChat === true,
  );
  const everyProject = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.everyProject === true,
  );
  const asksEveryProject = useSyncExternalStore(
    subscribeMonos,
    () => soulAsks(soul) || soulAsks(findMono(monoId)?.instructions),
  );
  return (
    <div
      ref={lock}
      className="min-h-0 flex-1 overflow-y-auto overscroll-none px-8 pb-8 pt-6"
    >
      <h3 className="text-[14px] font-medium text-content">General</h3>

      <div className="flex flex-col items-center pb-6 pt-4">
        <LookButton monoId={monoId} agent={agent} />
        <NameField key={monoId} monoId={monoId} fallback={agent.mascot} />
      </div>

      {/* WP-182: the card stands in for the first page's model and worker blocks. */}
      <MonoCard
        monoId={monoId}
        cwd={cwd}
        harness={harness}
        model={model}
        modelSettings={modelSettings}
        busy={busy}
        onModelChange={onModelChange}
        onModelSettingsChange={onModelSettingsChange}
      />
      {/* WP-215: the personality sits beside the engine. The charter is not edited here. */}
      {soul && hasCaptainCharter(soul) ? <CaptainPersonality monoId={monoId} soul={soul} /> : null}

      <GroupHeading title="Permissions" />
      <SettingGroup>
        <SettingRow
          label="Permissions"
          description="What it may do without asking."
        >
          <AccessPicker
            value={runtimeMode}
            harness={harness}
            onChange={onRuntimeModeChange}
            busy={busy}
            side="bottom"
            variant="plain"
          />
        </SettingRow>
      </SettingGroup>

      <GroupHeading
        title="Projects"
        description="It can see every session, note and folder in these."
      />
      <SettingGroup>
        <MonoProjects monoId={monoId} projects={agent.projects} />
      </SettingGroup>

      <GroupHeading title="Sessions it starts" />
      <SettingGroup>
        <SwitchRow
          label="Show sessions in sidebar"
          description="Sessions it starts appear in your project sidebar. Hidden ones stay saved and open from its overview."
          on={shown}
          onChange={(on) =>
            updateMono(monoId, (mono) => ({
              ...mono,
              showStartedSessionsInSidebar: on,
            }))
          }
        />
        {/* Hidden sessions have no sidebar folder to go in. */}
        <SwitchRow
          label="Group in a folder"
          description={`Sessions it starts go in a “${agent.name}” folder in your project sidebar.`}
          on={shown && folders}
          disabled={!shown}
          onChange={(on) =>
            updateMono(monoId, ({ useSidebarFolders: _, ...mono }) =>
              on ? { ...mono, useSidebarFolders: true } : mono,
            )
          }
        />
      </SettingGroup>

      <GroupHeading
        title="Long chat"
        description="Off: each conversation starts on its soul and memory notes. On: it also remembers the whole chat."
      />
      <SettingGroup>
        <SwitchRow
          label="Keep one long chat"
          description="Remembers the whole chat and opens it back up word for word. Memory notes and New conversation stay as they are."
          on={longChat}
          onChange={(on) => {
            updateMono(monoId, ({ longChat: _, ...mono }) =>
              on ? { ...mono, longChat: true } : mono,
            );
            if (on) void openTree(monoId).catch(() => undefined);
            else closeTree(monoId);
          }}
        />
        {longChat ? <LongChatView monoId={monoId} /> : null}
      </SettingGroup>

      {asksEveryProject ? (
        <SettingGroup>
          <SwitchRow
            label="Read every project"
            description="Reads tasks, pages and activity on this copy. It still files work into one project."
            on={everyProject}
            onChange={(on) => {
              updateMono(monoId, ({ everyProject: _flag, ...mono }) => (on ? { ...mono, everyProject: true } : mono));
              if (on) void ensureMorningHabit(monoId, loadHabits, async (id, change) => updateHabits(id, change), Date.now()).catch(() => undefined);
            }}
          />
        </SettingGroup>
      ) : null}

      {onReset ? (
        <>
          <GroupHeading title="Conversation" />
          <ConfirmReset
            label="Reset conversation"
            title={`Reset ${agent.name}'s conversation?`}
            body="All messages in this Mono's conversation will be deleted and any active reply will be stopped. This can't be undone."
            kept="Its soul, memory and habits will be kept."
            failure="Could not reset the conversation."
            onConfirm={onReset}
          >
            {(open, ref) => (
              <SettingGroup>
                <SettingRow
                  label="Reset conversation"
                  description="Clear all messages and start fresh. Its soul, memory and habits stay."
                >
                  <button
                    ref={ref}
                    type="button"
                    onClick={open}
                    className="rounded-md border border-stroke px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
                  >
                    Reset
                  </button>
                </SettingRow>
              </SettingGroup>
            )}
          </ConfirmReset>
        </>
      ) : null}
    </div>
  );
}

/** A titled group of settings, with what it covers under the title. */
function GroupHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="px-1 pb-2 pt-7">
      <h4 className="text-[12px] font-medium text-content/70">{title}</h4>
      {description ? (
        <p className="text-[12px] leading-5 text-content/40">{description}</p>
      ) : null}
    </div>
  );
}

/** Settings that belong together, in one card with a line between rows. */
function SettingGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-stroke rounded-xl border border-stroke bg-content/[0.02]">
      {children}
    </div>
  );
}

/**
 * A setting's name and what it does on the left, its control on the right.
 * Controls get a column of their own, wide enough that a value is never cut.
 */
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-5 text-content/90">{label}</span>
        {description ? (
          <span className="text-[12px] leading-5 text-content/40">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex w-56 shrink-0 items-center justify-end pr-1.5 text-[12px] text-content/85">
        {children}
      </div>
    </div>
  );
}

/** The Mono's face, which opens its mascots and colors in a popover. */
function LookButton({ monoId, agent }: { monoId: string; agent: MonoLook }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Change mascot and color"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change mascot and color"
        onClick={() => setOpen((value) => !value)}
        className={`grid size-20 shrink-0 place-items-center rounded-2xl border border-stroke hover:bg-content/8 ${
          open ? "bg-content/8" : "bg-content/4"
        }`}
      >
        <PixelMascot
          name={agent.mascot}
          color={agent.color}
          className="size-12 shrink-0"
        />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="center"
          width={272}
          constrainHeight={false}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Mascot and color"
          className="flex flex-col gap-3 p-3"
        >
          <MascotPicker
            columns={5}
            current={agent.mascot}
            color={agent.color}
            onPick={(mascot) => saveMonoMascot(monoId, mascot)}
          />
          <TileLettersField monoId={monoId} name={agent.name} />
          <div className="h-px bg-content/10" />
          <ColorPicker
            inline
            columns={5}
            current={agent.color}
            onPick={(color) =>
              updateMono(monoId, (mono) => ({ ...mono, color }))
            }
          />
        </Popover>
      ) : null}
    </>
  );
}

/** How long a name change settles before it saves without a blur. */
export const NAME_SETTLE_MS = 500;

/** The Mono's name, edited in place; empty goes back to its mascot's name. */
function NameField({ monoId, fallback }: { monoId: string; fallback: string }) {
  const saved = () => findMono(monoId)?.name ?? "";
  const [draft, setDraft] = useState(saved);
  const editing = useRef(false);
  // A reset clears the name while this dialog is open.
  useEffect(
    () =>
      subscribeMonos(() => {
        if (!editing.current) setDraft(saved());
      }),
    [monoId],
  );
  const placeholder = defaultMonoName(fallback);
  const save = () => {
    const name = draft.trim().slice(0, 40);
    if (name !== saved()) saveMonoName(monoId, name);
    setDraft(name);
  };
  // r62 (A3): a name set without typing (accessibility, autofill, paste with no blur) saves on the change itself, a
  // moment after it settles, and whatever is in the field when the dialog closes is kept. An empty field only goes back
  // to the mascot's name on leaving it, so clearing to retype never flashes the default name.
  const latest = useRef(draft);
  latest.current = draft;
  // A value set straight on the element (some accessibility clients fire no input event) is read from it on close.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const name = draft.trim().slice(0, 40);
    if (!name || name === saved()) return;
    const timer = setTimeout(() => saveMonoName(monoId, name), NAME_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft, monoId]);
  useEffect(() => {
    const element = field.current;
    return () => {
      const name = (element?.value ?? latest.current).trim().slice(0, 40);
      if (name !== saved()) saveMonoName(monoId, name);
    };
  }, [monoId]);
  return (
    <input
      ref={field}
      aria-label="Name"
      value={draft}
      placeholder={placeholder}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !isImeComposition(event.nativeEvent)) {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(saved());
          event.currentTarget.blur();
        }
      }}
      className="mt-3 h-8 w-full max-w-64 rounded-md bg-transparent px-2 text-center text-[15px] font-medium text-content outline-none placeholder:text-content/60 hover:bg-content/5 focus:bg-content/5"
    />
  );
}

/** The letters on the Mono's tile: Ash's own (one or two, as typed), or empty for the automatic ones. */
function TileLettersField({ monoId, name }: { monoId: string; name: string }) {
  const mono = findMono(monoId);
  const chosen = mono?.mascotPicked && mono.mascot.startsWith(`${LETTER_AVATAR}:`) ? mono.mascot.slice(LETTER_AVATAR.length + 1) : "";
  return (
    <label className="flex items-center justify-between gap-2 px-1 text-[12px] text-content/70">
      Tile letters
      <input
        key={chosen}
        data-mono-tile-letters
        aria-label="Tile letters"
        maxLength={2}
        defaultValue={chosen}
        placeholder={monoTileLetters(name)}
        onBlur={(e) => {
          if (e.currentTarget.value.trim() !== chosen) saveMonoTileLetters(monoId, e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-6 w-14 rounded-md bg-content/8 px-2 text-center text-[12px] text-content outline-none ring-1 ring-inset ring-content/15 placeholder:text-content/60"
      />
    </label>
  );
}
