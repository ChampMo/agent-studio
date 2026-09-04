/**
 * The run's name, and a pencil to change it.
 *
 * Only the **title**. `missions.goal` is what the team was actually asked and
 * is not editable from anywhere — migration 0010 split the two apart for this
 * reason, and a run whose instruction could be rewritten afterwards would make
 * every replay unverifiable against the thing it was given (§5.1). The pencil
 * sits on the name; the instruction is the first message in the transcript,
 * where it was said.
 *
 * Editing in place rather than in a dialog: it is one short field, and a modal
 * for it would cover the transcript that tells you what to call it.
 */
import { useEffect, useRef, useState } from "react";

import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { PencilIcon } from "../../components/ui/icons";
import { useHistoryStore } from "../../stores/historyStore";
import { useMissionStore } from "../../stores/missionStore";
import { api } from "../../transport/rest";

export function RunTitle() {
  const missionId = useMissionStore((s) => s.missionId);
  const title = useMissionStore((s) => s.title);
  const setTitle = useMissionStore((s) => s.setTitle);
  const reload = useHistoryStore((s) => s.load);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  // A different run is a different name: leaving the editor open across a
  // switch would put one run's title in the box over another run's header.
  useEffect(() => {
    setEditing(false);
  }, [missionId]);

  async function commit() {
    const next = draft.trim();
    if (!missionId || !next || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api.renameMission(missionId, next);
      setTitle(next);
      // The sidebar lists it by this name, so it has to hear about it.
      await reload();
      setEditing(false);
    } catch {
      // Left open with what was typed still in it: the rename did not happen,
      // and closing the box would look exactly like it had.
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={field}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          // Escape abandons it. The old name is still in the store, so there
          // is nothing to restore.
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={strings.mission.renameLabel}
        className={cn(
          "w-full max-w-[28rem] rounded-card border border-line bg-solid px-2 py-0.5",
          "text-[17px] font-semibold leading-snug text-text",
          "focus:border-accent focus:outline-none",
        )}
      />
    );
  }

  return (
    <div className="group/title flex items-center gap-1.5">
      {/* 17px, and the run's *title* — a name, not the paragraph the team was
          given. */}
      <h1 className="text-[17px] font-semibold leading-snug text-text">
        {title || strings.mission.untitled}
      </h1>
      {missionId ? (
        <button
          type="button"
          onClick={() => {
            setDraft(title || "");
            setEditing(true);
          }}
          title={strings.mission.rename}
          aria-label={strings.mission.rename}
          className={cn(
            "flex size-[24px] shrink-0 items-center justify-center rounded-card",
            "text-faint hover:bg-solid-2 hover:text-text",
            // Quiet until wanted: renaming is rare, and a permanent pencil
            // beside every title is a control competing with the title.
            // Focus keeps it reachable without a pointer (WCAG 2.1.1).
            "opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100",
          )}
        >
          <PencilIcon />
        </button>
      ) : null}
    </div>
  );
}
