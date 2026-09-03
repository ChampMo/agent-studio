/**
 * When a tool call stops to ask, decided where you can see it (§16.4, §2.7).
 *
 * This was a dropdown in the agent editor, below the tool list. Two things were
 * wrong with that. It asked a security question **once per agent**, so a team
 * of five had five answers to something the person means once. And it lived on
 * a page nobody has open while work is happening — which is precisely when you
 * want to say "stop asking" or "ask me about everything".
 *
 * One value, beside the composer. Changing it takes effect on the **next** run:
 * each mission freezes the setting into its snapshot at launch, so a run that
 * started under "ask before everything" keeps asking even if the switch moves
 * while it works (§5.1).
 *
 * `trusted` carries its warning here because this is where the choice is now,
 * and the wording does not soften it: there is no sandbox behind the gate.
 */
import { useEffect, useState } from "react";
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { usePrefsStore, type Autonomy } from "../../stores/prefsStore";
import { Menu } from "../../components/ui/Menu";
import { ChevronDownIcon } from "../../components/ui/icons";

const CHOICES: Autonomy[] = ["ask_always", "ask_dangerous", "trusted"];

export function AutonomyControl({ running }: { running: boolean }) {
  const autonomy = usePrefsStore((s) => s.autonomy);
  const setAutonomy = usePrefsStore((s) => s.setAutonomy);
  const load = usePrefsStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * "Never ask" is held for a second click.
   *
   * It is one menu row away from turning off every approval in the app, and
   * there is no sandbox behind that gate (§2.7) — so a stray click on it is
   * the most expensive misclick this interface offers. It happened three times
   * while this screen was being built, which is the evidence rather than the
   * theory.
   *
   * The other two options apply immediately: choosing to be asked *more* is
   * not a decision that needs protecting.
   */
  const [pending, setPending] = useState(false);

  return (
    <>
      {/* A word, not a form control. It was a full-width labelled `<select>`
          with a border and a background, which made a setting you touch rarely
          the heaviest thing in the composer's footer. Now it reads as text
          until you reach for it, and opens the same popup the `+` uses — one
          menu pattern in this row, not a dropdown and a popup side by side. */}
      <Menu
        label={strings.tools.autonomy}
        selectedLabel={strings.tools.autonomyOptions[autonomy]}
        triggerClassName={cn(
          "flex min-h-[24px] items-center gap-1 rounded-card px-2 text-xs",
          "transition-colors hover:bg-solid hover:text-text",
          // Amber, not red. Turning the gate off is worth noticing and is not
          // an error — red is kept for things that have gone wrong or cannot
          // be undone, and spending it here would make it mean less there.
          autonomy === "trusted" ? "text-wait" : "text-muted",
        )}
        trigger={
          <>
            {strings.tools.autonomyShort[autonomy]}
            <ChevronDownIcon size={13} className="text-faint" />
          </>
        }
        items={CHOICES.map((option) => ({
          label: strings.tools.autonomyOptions[option] ?? option,
          // The one that removes the only gate says so where it is chosen,
          // not in a warning somewhere else (§2.7).
          hint: option === "trusted" ? strings.tools.trustedShort : undefined,
          tone: option === "trusted" ? ("warn" as const) : undefined,
          onSelect: () =>
            option === "trusted" ? setPending(true) : void setAutonomy(option),
        }))}
      />

      {pending ? (
        <span className="flex items-center gap-2 text-[11px]">
          <span className="text-wait">{strings.tools.confirmTrusted}</span>
          <button
            type="button"
            onClick={() => {
              setPending(false);
              void setAutonomy("trusted");
            }}
            className="min-h-[24px] rounded-card px-2 text-wait hover:bg-wait/10"
          >
            {strings.tools.confirmTrustedYes}
          </button>
          <button
            type="button"
            onClick={() => setPending(false)}
            className="min-h-[24px] rounded-card px-2 text-muted hover:bg-solid hover:text-text"
          >
            {strings.tools.confirmTrustedNo}
          </button>
        </span>
      ) : null}

      {/* Only while a run is going, because that is when it matters that the
          change has not taken effect on the run in front of you. */}
      {running ? (
        <span className="text-[11px] text-faint">{strings.tools.autonomyNextRun}</span>
      ) : null}
    </>
  );
}
