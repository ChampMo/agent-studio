/**
 * Pick an avatar from the assets that exist (PROJECT_BRIEF.md §11).
 *
 * The options come from the backend's catalogue, not a copy kept here — the
 * same list the generator is shown and validated against. A picker with its own
 * hardcoded list would drift the first time an asset is added, and the mismatch
 * would only surface in M5 when a sprite failed to load.
 */
import { strings } from "../../lib/constants/strings.en";
import { Portrait } from "../../components/ui/Portrait";
import { Select } from "../../components/ui/Select";
import type { AvatarConfig } from "../../transport/rest";

export function AvatarPicker({
  assets,
  value,
  onChange,
  name = "",
}: {
  assets: Record<string, string[]>;
  value: AvatarConfig;
  onChange: (next: AvatarConfig) => void;
  /** Only for the preview's initials fallback and its accessible name. */
  name?: string;
}) {
  const slots = Object.entries(assets);
  if (slots.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-text">
        {strings.creator.avatarLabel}
      </div>
      {/* The face, beside the four menus that make it. Choosing "sturdy /
          hooded / cloak / ink" from dropdowns and finding out what it looks
          like only once a mission is running is a needlessly blind way to pick
          from a closed catalogue — and this is the same `Portrait` the
          transcript and the rail draw, so what is previewed is what appears. */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-[9px] border border-line bg-solid p-2">
          <Portrait avatar={value} name={name || "?"} size={56} />
        </div>
        <div className="min-w-0 flex-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {slots.map(([slot, options]) => (
          // A <label> wrapping the control no longer associates: `Select`
          // renders a button, and implicit labelling only works for form
          // elements. `htmlFor` + `id` is the explicit form, and it works for
          // both.
          <div key={slot} className="space-y-1">
            <label htmlFor={`avatar-${slot}`} className="block text-xs text-faint">
              {slot}
            </label>
            <Select
              id={`avatar-${slot}`}
              label={slot}
              value={value[slot] ?? options[0] ?? ""}
              onChange={(next) => onChange({ ...value, [slot]: next })}
              options={options.map((option) => ({
                value: option,
                label: option.replace(/_/g, " "),
              }))}
            />
          </div>
        ))}
        </div>
      </div>
      <p className="text-xs text-faint">{strings.creator.avatarHint}</p>
    </div>
  );
}
