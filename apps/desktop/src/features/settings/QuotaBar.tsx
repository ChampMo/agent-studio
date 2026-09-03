/**
 * A search key's allowance, where the endpoint reports one (§16.5).
 *
 * The rule this component exists to keep: **a bar is a claim about a
 * measurement, so there is no bar without one.** Tavily sends no rate-limit
 * header at all, and a paid Brave plan declares its monthly window with a limit
 * of zero — drawing either as an empty meter would say "you are out of
 * searches" about accounts that are not (§1.1).
 *
 * So three renderings for three different facts, and the words differ as much
 * as the shapes do. `quota.ts` decides which; this only draws it.
 *
 * The line under the bar is not decoration either. The number arrives on the
 * response to a real search, so it was taken when the key was tested and
 * searches since then are not in it. A meter that looked live would be the more
 * comfortable lie.
 */
import { strings } from "../../lib/constants/strings.en";
import { cn } from "../../lib/cn";
import { readQuota } from "./quota";
import type { QuotaWindow } from "../../transport/rest";

const number = new Intl.NumberFormat("en-GB");

export function QuotaBar({ quota }: { quota: QuotaWindow[] | null }) {
  const view = readQuota(quota);

  // Two different sentences, because they are two different facts: one is the
  // endpoint's answer, the other is that nobody has asked it. `verifiedAt` is
  // deliberately not consulted — every key tested before this reading existed
  // has one, and reading it here would call those endpoints silent.
  if (view.kind === "unmeasured") {
    return <p className="text-[11px] text-faint">{strings.settings.quotaUntested}</p>;
  }
  if (view.kind === "silent") {
    return <p className="text-[11px] text-faint">{strings.settings.quotaSilent}</p>;
  }

  if (view.kind === "rate") {
    return (
      <p className="text-[11px] text-faint">
        {strings.settings.quotaRate(
          number.format(view.limit),
          view.unit,
          view.per,
        )}
      </p>
    );
  }

  // The bar fills with what has been **spent**, so a full bar means the
  // allowance is gone. Drawn the other way it read as a battery, where full is
  // good and empty is bad — the opposite meaning from the same picture, which
  // is exactly the kind of thing nobody re-reads once they have decided what a
  // bar means.
  const spent = view.used / view.limit;

  return (
    <div className="space-y-1">
      {/* The sentence says what is left, because that is the number anyone is
          actually asking for. The bar is labelled by what the bar draws. Two
          phrasings of one fact, each attached to the thing it describes. */}
      <p className="text-[11px] text-muted">
        {strings.settings.quotaLeft(
          number.format(view.remaining),
          number.format(view.limit),
          view.unit,
          view.per,
        )}
      </p>
      <div
        role="meter"
        aria-label={strings.settings.quotaUsed(
          number.format(view.used),
          number.format(view.limit),
          view.unit,
          view.per,
        )}
        aria-valuenow={view.used}
        aria-valuemin={0}
        aria-valuemax={view.limit}
        className="h-1 w-full overflow-hidden rounded-full bg-solid-2"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            // Colour is the second signal, never the only one: the sentence
            // above already says the numbers (§18.3, WCAG 1.4.1).
            spent >= 0.9 ? "bg-stop" : spent >= 0.75 ? "bg-wait" : "bg-done",
          )}
          style={{ width: `${Math.max(0, Math.min(100, spent * 100))}%` }}
        />
      </div>
      <p className="text-[10px] text-faint">{strings.settings.quotaMeasured}</p>
    </div>
  );
}
