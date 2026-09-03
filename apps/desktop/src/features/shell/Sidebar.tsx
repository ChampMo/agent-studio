/**
 * Past work, down the left (§18.2).
 *
 * A chat is a degenerate mission (§15 row 4), which was always true and is only
 * now visible: one list, one query, chats and team runs together. That is why
 * there is no History screen any more — it was the same rows behind a different
 * tab.
 *
 * The search box owns the query and the list reads it, rather than the list
 * owning both: the field belongs above the scroll area and the rows inside it,
 * and a query that lived in the scrolling part would scroll away.
 */
import { useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import {
  PersonIcon,
  PlusIcon,
  SettingsIcon,
  TeamIcon,
} from "../../components/ui/icons";
import { MissionList } from "./MissionList";

export type SidebarPlace = "work" | "roster" | "teams" | "settings";

const PLACES: { id: SidebarPlace; label: string; icon: React.ReactNode }[] = [
  // The icon is decorative and the label carries the meaning — these are never
  // icon-only, so the picture only has to make the row scannable (§18.3).
  { id: "roster", label: strings.sidebar.roster, icon: <PersonIcon size={15} /> },
  { id: "teams", label: strings.sidebar.teams, icon: <TeamIcon size={15} /> },
  { id: "settings", label: strings.sidebar.settings, icon: <SettingsIcon size={15} /> },
];

export function Sidebar({
  place,
  onGo,
  onNewRun,
}: {
  place: SidebarPlace;
  onGo: (place: SidebarPlace) => void;
  onNewRun: () => void;
}) {
  const [query, setQuery] = useState("");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="text-sm font-semibold text-text">{strings.app.name}</span>
      </div>

      {/* Search first. Finding a run you already have is the thing done most
          often in this column, and it was sitting under a filled button that
          took the eye every time the sidebar was looked at.

          A real label, not a placeholder pretending to be one (§18.3). */}
      <div className="space-y-1">
        <label htmlFor="mission-search" className="sr-only">
          {strings.sidebar.searchLabel}
        </label>
        <input
          id="mission-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={strings.sidebar.searchPlaceholder}
          className={cn(
            "w-full rounded-card border border-line bg-solid px-3 py-2 text-sm",
            "text-text placeholder:text-faint",
          )}
        />
      </div>

      {/* Quiet, and only as wide as its words. It was a full-width accent slab
          — the loudest element in the app for an action taken once a session.
          The visible word is "New"; the accessible name stays "New run", which
          contains it, so the two agree (WCAG 2.5.3). */}
      <button
        type="button"
        onClick={onNewRun}
        aria-label={strings.sidebar.newRun}
        className={cn(
          "flex min-h-[32px] w-fit items-center gap-1.5 rounded-card px-2 text-sm",
          "text-muted transition-colors hover:bg-solid hover:text-text",
        )}
      >
        <PlusIcon size={15} />
        {strings.sidebar.newShort}
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <MissionList query={query} onOpened={() => onGo("work")} />
      </div>

      <div className="space-y-0.5 border-t border-line pt-2">
        {PLACES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onGo(entry.id)}
            aria-current={place === entry.id ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-card px-2.5 py-2 text-left text-sm",
              place === entry.id
                ? "bg-solid-2 text-text"
                : "text-muted hover:bg-solid hover:text-text",
            )}
          >
            <span aria-hidden="true" className="shrink-0">
              {entry.icon}
            </span>
            <span className="truncate">{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
