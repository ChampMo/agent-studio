/**
 * Pick an avatar from the assets that exist (PROJECT_BRIEF.md §11).
 *
 * The options come from the backend's catalogue, not a copy kept here — the
 * same list the generator is shown and validated against. A picker with its own
 * hardcoded list would drift the first time an asset is added, and the mismatch
 * would only surface in M5 when a sprite failed to load.
 */
import { strings } from "../../lib/constants/strings.en";
import type { AvatarConfig } from "../../transport/rest";

export function AvatarPicker({
  assets,
  value,
  onChange,
}: {
  assets: Record<string, string[]>;
  value: AvatarConfig;
  onChange: (next: AvatarConfig) => void;
}) {
  const slots = Object.entries(assets);
  if (slots.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-slate-200">
        {strings.creator.avatarLabel}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {slots.map(([slot, options]) => (
          <label key={slot} className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              {slot}
            </span>
            <select
              value={value[slot] ?? options[0]}
              onChange={(e) => onChange({ ...value, [slot]: e.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">{strings.creator.avatarHint}</p>
    </div>
  );
}
