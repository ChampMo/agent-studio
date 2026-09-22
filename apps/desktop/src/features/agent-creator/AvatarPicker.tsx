/**
 * Pick an avatar from the assets that exist (PROJECT_BRIEF.md §11).
 *
 * The options come from the backend's catalogue, not a copy kept here — the
 * same list the generator is shown and validated against. A picker with its own
 * hardcoded list would drift the first time an asset is added, and the mismatch
 * would only surface when a sprite failed to load.
 *
 * **Every option is drawn as the cat it would make.** This was three
 * dropdowns, which is a list of words for a decision that is entirely about a
 * picture: `bombay` and `tortie` mean nothing until you have seen them, so
 * choosing between them from a menu is guessing and then checking. Each
 * swatch here is `{...value, [slot]: option}` rendered through the same
 * `Portrait` the transcript and the rail use — so what you are shown is not a
 * representation of the choice, it is the choice.
 *
 * That also keeps this component ignorant of what the slots *are*. It does not
 * know that `breed` is fur and `headwear` is worn on the head; it renders each
 * option by making the change and looking at the result. That ignorance is
 * what let the catalogue change shape four times without this file changing
 * at all — `collar` was added on the backend and appeared here, previewed
 * correctly, with nothing to edit (§8).
 */
import { useId } from "react";

import { strings } from "../../lib/constants/strings.en";
import { Portrait } from "../../components/ui/Portrait";
import { cn } from "../../lib/cn";
import type { AvatarConfig } from "../../transport/rest";

/**
 * A readable name for a slot the app knows, and the backend's own word for one
 * it does not.
 *
 * The fallback is the point: this must not be the place that decides which
 * slots exist. An unrecognised key is shown as it arrived rather than hidden,
 * because a slot nobody can see is a slot nobody can set (§8).
 */
const SLOT_NAMES: Record<string, string> = {
  breed: "Fur",
  size: "Size",
  headwear: "On the head",
  glasses: "Glasses",
  collar: "Collar",
  //: The accessory slot that became those two. Named because a machine that
  //: has not run 0024 yet is still served it.
  prop: "Accessory",
  // The one-slot catalogue, which existed for one build. Kept because this
  // component renders whatever the backend sends, and a machine that ran it
  // and has not migrated yet is served `cat` — named rather than a bare key.
  cat: "Fur",
};

function label(slot: string): string {
  return SLOT_NAMES[slot] ?? slot.replace(/_/g, " ");
}

function pretty(option: string): string {
  return option.replace(/_/g, " ");
}

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
  const id = useId();
  if (slots.length === 0) return null;

  /** One of each, at random. A shortcut, not a suggestion: nothing here reads
   *  the role or the name, so it cannot be mistaken for the app having an
   *  opinion about what this agent should look like. */
  const shuffle = () => {
    const next: AvatarConfig = { ...value };
    for (const [slot, options] of slots) {
      const pick = options[Math.floor(Math.random() * options.length)];
      if (pick) next[slot] = pick;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-text">
        {strings.creator.avatarLabel}
      </div>

      {/* Beside each other, not stacked.

          Full-width the stage was a band of empty floor with a cat in the
          middle of it, and the rows it belonged to had scrolled off. Side by
          side the preview sits level with the swatches that change it, so
          picking one and seeing the result is a glance rather than a scroll —
          and the stage stops being mostly background.

          It stacks again below `sm`, where two columns would leave the swatch
          rows too narrow to hold eight of anything. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex shrink-0 items-center justify-center rounded-card border border-line bg-room-sky px-4 py-5 sm:w-[196px]">
          <div className="relative flex flex-col items-center">
            {/* A shallow diamond under the cat, not around it. The first version
              was a tall one centred on the portrait, so the floor cut across
              the cat's chest — a room drawn through its occupant. This one is
              seen from the same low angle the scene uses and stops where the
              cat stands. */}
            <div className="relative z-10">
              <Portrait avatar={value} name={name || "?"} size={128} />
            </div>
            <svg
              aria-hidden="true"
              viewBox="0 0 200 46"
              className="-mt-3 w-[180px]"
            >
              <polygon
                points="100,2 198,23 100,44 2,23"
                fill="var(--room-floor-a)"
                stroke="var(--room-floor-b)"
              />
            </svg>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {slots.map(([slot, options]) => {
            const current = value[slot] ?? options[0] ?? "";
            return (
              <div key={slot} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span id={`${id}-${slot}`} className="text-xs text-muted">
                    {label(slot)}
                  </span>
                  {/* The chosen option in words. The ring says *which* one; this
                  says what it is called, because a highlighted picture and a
                  colour are not a label on their own (§18.3). */}
                  <span className="text-xs text-text">{pretty(current)}</span>
                </div>

                <div
                  role="radiogroup"
                  aria-labelledby={`${id}-${slot}`}
                  className="flex flex-wrap gap-1.5"
                >
                  {options.map((option) => {
                    const chosen = option === current;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        // Named, not only drawn: for anyone not looking at the
                        // pictures this is a list of options and each needs a
                        // word.
                        aria-label={pretty(option)}
                        title={pretty(option)}
                        onClick={() => onChange({ ...value, [slot]: option })}
                        className={cn(
                          "rounded-card border p-0.5 transition-colors",
                          chosen
                            ? "border-accent bg-accent/10"
                            : "border-line hover:border-line-strong",
                        )}
                      >
                        {/* The cat this option would make, not a swatch
                        standing for it — which is why this loop needs to know
                        nothing about slots.

                        Sized by how many rows there are rather than by a fixed
                        number: one row of options can be looked at properly,
                        and the same 56px across four rows would push the stage
                        beside it out of view. */}
                        <Portrait
                          avatar={{ ...value, [slot]: option }}
                          name={name || "?"}
                          size={slots.length === 1 ? 56 : 34}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={shuffle}
          className={cn(
            "shrink-0 rounded-card border border-line px-2.5 py-1 text-xs",
            "text-muted transition-colors hover:bg-solid hover:text-text",
          )}
        >
          {strings.creator.avatarShuffle}
        </button>
        <p className="min-w-0 flex-1 text-xs text-faint">
          {strings.creator.avatarHint}
        </p>
      </div>
    </div>
  );
}
