/**
 * Who this teammate was on this run, on hover (§18.3).
 *
 * The rail's row has room for a name, a number and a bar. Everything else
 * about a member is a click into Roster away — and Roster shows them as they
 * are **now**, which for a run from last week is a different person: renamed,
 * re-modelled, carrying different tools. This card reads the mission's own
 * frozen snapshot instead, so what it says is what actually ran (§5.1).
 *
 * The field that earns it a place is **tools**. Nothing else on screen during
 * a run says what a member could do, and it is the fact behind the whole
 * `leader_only_tool` class of failure — a research team whose web tools sat on
 * the one member the orchestrator never assigns a task to. On this card you
 * can see it.
 *
 * Two sources, kept apart because they are different kinds of claim:
 *
 * - **frozen** — name, title, role, seat, model, tools. True of the launch and
 *   true for ever after.
 * - **live** — tokens and status, off the log, changing as you watch.
 *
 * `autonomy` is in the snapshot and is deliberately **not** shown. The gate
 * reads that setting live now, so the frozen value records only what the run
 * started under, and a card saying "asks first" beside a run whose switch was
 * moved half an hour ago would be stating the wrong thing confidently.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Portrait } from "../../components/ui/Portrait";
import { cn } from "../../lib/cn";
import { formatTokens } from "./vitals";
import { strings } from "../../lib/constants/strings.en";
import type { SnapshotMember } from "../../stores/missionStore";

export interface CardFacts {
  /** Off the log, so null until the member has actually spent something. */
  tokens: number;
  /** The round's total, for the share. */
  roundTokens: number;
  /** The word the log published, already resolved to a label and a tone. */
  status: { label: string; tone: string } | null;
}

/** Where the card goes, measured from the row rather than assumed. */
interface Spot {
  top: number;
  /** One of the two, never both: which edge the card is pinned by decides
   *  which side of the row it grows into. */
  left?: number;
  right?: number;
}

const WIDTH = 300;
/** Clear of the panel's own edge. */
const GAP = 10;

export function MemberCard({
  member,
  facts,
  anchor,
}: {
  member: SnapshotMember;
  /** What the run has spent on them, and what they are doing.
   *
   *  Omitted where there is no run — the team builder shows the same card over
   *  a roster that has not been sent anywhere. Absent is not zero: a team being
   *  assembled has not spent nothing, it has not started. */
  facts?: CardFacts;
  /** The row this card belongs to. */
  anchor: HTMLElement;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);

  // Fixed, and through a portal, because both the rail and the team builder's
  // roster column are `overflow-hidden` — a popover positioned inside either
  // would be clipped at exactly the edge it has to cross.
  useLayoutEffect(() => {
    const place = () => {
      const row = anchor.getBoundingClientRect();
      const height = card.current?.offsetHeight ?? 0;
      // Whichever side the row has room on.
      //
      // The rail is against the right edge of the window, so its cards open
      // leftward. The team builder's roster is against the *left*, and opening
      // leftward there ran the card off the screen — the same measurement
      // decides both instead of one of them being assumed.
      const roomLeft = row.left - GAP >= WIDTH + GAP;
      setSpot({
        ...(roomLeft
          ? { right: Math.max(GAP, window.innerWidth - row.left + GAP) }
          : { left: Math.min(row.right + GAP, window.innerWidth - WIDTH - GAP) }),
        // Aligned to the row, then pulled back inside the window if the card
        // is taller than the space below it. Measured, not assumed.
        top: Math.min(
          Math.max(GAP, row.top - 4),
          Math.max(GAP, window.innerHeight - height - GAP),
        ),
      });
    };
    place();
    // A second pass once the card has a height: the first runs before it is
    // laid out, so the clamp above had nothing to clamp against.
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  const share =
    facts && facts.roundTokens > 0
      ? Math.round((facts.tokens / facts.roundTokens) * 100)
      : null;
  const tools = member.tools ?? [];

  return createPortal(
    <div
      ref={card}
      role="tooltip"
      id={`member-card-${member.agent_id}`}
      style={{
        width: WIDTH,
        top: spot?.top ?? -9999,
        ...(spot?.left !== undefined
          ? { left: spot.left }
          : { right: spot?.right ?? -9999 }),
        // Hidden until it has been placed, so it never flashes at the corner
        // on the way to where it belongs.
        visibility: spot ? "visible" : "hidden",
      }}
      className={cn(
        "fixed z-50 flex flex-col gap-3 rounded-card border border-line",
        // Solid, not glass: this is content with words in it.
        "bg-solid-2 p-3.5 shadow-lg",
      )}
    >
      <div className="flex items-start gap-3">
        <Portrait avatar={member.avatar_config} name={member.name} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{member.name}</p>
          {member.title ? (
            <p className="truncate text-xs text-muted">{member.title}</p>
          ) : null}
          {/* A negative index means they are not seated — the roster list in
              the team builder, where "Seat -1" would be nonsense and "Seat 0"
              would be a lie. */}
          {member.seat_index >= 0 ? (
            <p className="mt-0.5 text-[11px] text-faint">
              {strings.rail.seat(member.seat_index)}
              {member.role_in_team === "leader"
                ? ` · ${strings.rail.leader}`
                : ""}
            </p>
          ) : null}
        </div>
      </div>

      {/* The one line the agent's own profile uses to say what they do. */}
      {member.role ? (
        <p className="text-xs leading-relaxed text-muted">{member.role}</p>
      ) : null}

      <dl className="flex flex-col gap-1.5 border-t border-line pt-3 text-[11px]">
        <Row label={strings.rail.cardModel}>
          <span className="font-mono text-[10px] text-muted">
            {member.model ?? strings.rail.cardNoModel}
          </span>
        </Row>
        {/* Only inside a run. The rows are absent rather than zeroed on the
            builder, because "spent nothing" and "has not run" are different
            claims and only one of them is true there. */}
        {facts ? (
          <Row label={strings.rail.tokensUsed}>
            {facts.tokens > 0 ? (
              <span className="tabular-nums text-muted">
                {formatTokens(facts.tokens)}
                {share !== null ? (
                  <span className="text-faint"> · {strings.rail.cardShare(share)}</span>
                ) : null}
              </span>
            ) : (
              // Not "0". A member who has not been given a task yet has spent
              // nothing, and a zero implies they ran and cost nothing.
              <span className="text-faint">{strings.rail.cardNothingYet}</span>
            )}
          </Row>
        ) : null}
        {facts?.status ? (
          <Row label={strings.rail.cardStatus}>
            <span className={facts.status.tone}>{facts.status.label}</span>
          </Row>
        ) : null}
      </dl>

      <div className="flex flex-col gap-1.5 border-t border-line pt-3">
        <p className="text-[11px] text-faint">
          {tools.length > 0
            ? facts
              ? strings.rail.cardTools(tools.length)
              : strings.rail.cardCarries(tools.length)
            : facts
              ? strings.rail.cardNoTools
              : strings.rail.cardCarriesNone}
        </p>
        {tools.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {tools.map((tool) => (
              <li
                key={tool}
                className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted"
              >
                {tool}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/**
 * Which row the pointer or the keyboard is on.
 *
 * Focus counts, not only hover: a card that exists solely on hover is a card
 * some people cannot open at all (WCAG 2.1.1). Escape closes it, because a
 * thing that appeared over the work has to be dismissible without moving the
 * pointer (1.4.13).
 *
 * A short delay before opening, and none before closing. Sweeping the pointer
 * down five rows to reach the budget block should not raise five cards on the
 * way past.
 */
export function useHoverCard() {
  const [open, setOpen] = useState<{ id: string; el: HTMLElement } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      window.clearTimeout(timer.current);
    };
  }, []);

  return {
    open,
    show(id: string, el: HTMLElement, immediate = false) {
      window.clearTimeout(timer.current);
      if (immediate) {
        setOpen({ id, el });
        return;
      }
      timer.current = window.setTimeout(() => setOpen({ id, el }), 240);
    },
    hide() {
      window.clearTimeout(timer.current);
      setOpen(null);
    },
  };
}
